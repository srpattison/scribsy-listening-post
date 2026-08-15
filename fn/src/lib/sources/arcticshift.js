'use strict';

// Arctic Shift adapter — free community archive of Reddit (Pushshift successor).
// Docs: github.com/ArthurHeitmann/arctic_shift (api/README.md).
// Data lags live Reddit by days-to-weeks: built for history/depth, not freshness.
// Etiquette: a couple requests/second max; honor X-RateLimit-* headers.
// No uptime guarantees — every call is wrapped and the pipeline degrades softly.

const BASE = () => (process.env.ARCTIC_BASE || 'https://arctic-shift.photon-reddit.com').replace(/\/+$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(path, params) {
  const url = new URL(BASE() + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  await sleep(1000); // gentle: several backfill chunk-workers may run in parallel
  const res = await fetch(url, { headers: { 'User-Agent': 'scribsy-listening-post/1.0 (market research; steven@scribsy.ai)' } });
  if (res.status === 429) {
    const reset = parseInt(res.headers.get('X-RateLimit-Reset') || '30', 10);
    await sleep(Math.min(reset, 60) * 1000);
    return apiGet(path, params);
  }
  if (!res.ok) throw new Error(`ArcticShift GET ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return Array.isArray(body) ? body : body.data || [];
}

function normalizePost(d) {
  return {
    source: 'reddit',
    kind: 'post',
    subreddit: (d.subreddit || 'unknown').toLowerCase(), // community key
    id: d.id,
    title: d.title || '',
    selftext: (d.selftext || '').slice(0, 12_000),
    author: d.author,
    score: d.score || 0,
    num_comments: d.num_comments || 0,
    created_utc: typeof d.created_utc === 'number' ? d.created_utc : Math.floor(new Date(d.created_utc).getTime() / 1000),
    permalink: d.permalink ? 'https://www.reddit.com' + d.permalink : `https://www.reddit.com/r/${d.subreddit}/comments/${d.id}/`,
    flair: d.link_flair_text || null,
    is_self: d.is_self !== false
  };
}

// Posts for one subreddit in [afterUtc, beforeUtc), ascending by created_utc.
async function fetchPosts(subreddit, { afterUtc, beforeUtc, limit = 100 } = {}) {
  const rows = await apiGet('/api/posts/search', {
    subreddit,
    after: afterUtc ? new Date(afterUtc * 1000).toISOString() : undefined,
    before: beforeUtc ? new Date(beforeUtc * 1000).toISOString() : undefined,
    sort: 'asc',
    limit
  });
  return rows.map(normalizePost);
}

const stripPrefix = (v) => (v ? String(v).replace(/^t\d_/, '') : null);

// A comment as a first-class corpus row.
//
// The permalink must carry the comment shape — /comments/<linkId>/<slug>/<id> —
// because that is how a comment row is distinguished from a submission
// downstream (and it is the measurement that defined this defect: 0 of 200
// sampled rows matched it).
function normalizeComment(d) {
  const sub = (d.subreddit || 'unknown').toLowerCase();
  const linkId = stripPrefix(d.link_id);
  const parentRaw = d.parent_id ? String(d.parent_id) : '';
  const body = (d.body || '').slice(0, 12_000);
  return {
    source: 'reddit',
    kind: 'comment',
    subreddit: sub,
    id: d.id,
    linkId,
    // Top-level comments hang off the submission (t3_), replies off a comment (t1_).
    parentId: parentRaw.startsWith('t1_') ? stripPrefix(parentRaw) : null,
    title: body.split('\n')[0].slice(0, 200),
    selftext: body,
    author: d.author,
    score: d.score || 0,
    num_comments: 0,
    created_utc: typeof d.created_utc === 'number' ? d.created_utc : Math.floor(new Date(d.created_utc).getTime() / 1000),
    permalink: d.permalink
      ? 'https://www.reddit.com' + d.permalink
      : `https://www.reddit.com/r/${sub}/comments/${linkId}/comment/${d.id}/`,
    flair: null,
    is_self: true
  };
}

// Comments for one subreddit in [afterUtc, beforeUtc), ascending by created_utc.
// Same walk shape as fetchPosts so backfill can drive either.
async function fetchComments(subreddit, { afterUtc, beforeUtc, limit = 100 } = {}) {
  const rows = await apiGet('/api/comments/search', {
    subreddit,
    after: afterUtc ? new Date(afterUtc * 1000).toISOString() : undefined,
    before: beforeUtc ? new Date(beforeUtc * 1000).toISOString() : undefined,
    sort: 'asc',
    limit
  });
  return rows.map(normalizeComment);
}

// Replies attached to a submission's raw archive, for comment_stance_mix.
//
// Selection is CHRONOLOGICAL, not by score: Arctic Shift captures a
// near-creation snapshot with variable per-row lag, so ranking by `score` ranks
// by how late the archiver happened to look. See CB-LISTEN-REPO-4 §3c.
async function fetchComments_forPost(postId, max = 20) {
  const rows = await apiGet('/api/comments/search', {
    link_id: `t3_${postId}`,
    limit: 100
  });
  return rows
    .filter((c) => !c.parent_id || String(c.parent_id).startsWith('t3_')) // top-level only
    .sort((a, b) => (a.created_utc || 0) - (b.created_utc || 0))
    .slice(0, max)
    .map((c) => ({
      id: c.id,
      author: c.author,
      scoreAtCapture: c.score || 0, // stored, never ranked on
      body: (c.body || '').slice(0, 3000)
    }));
}

module.exports = {
  fetchPosts,
  fetchComments,
  fetchPostComments: fetchComments_forPost,
  normalizeComment,
  normalizePost
};
