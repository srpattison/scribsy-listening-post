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
  await sleep(600);
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

// Top-level comments for a post, best-scored first.
async function fetchTopComments(postId, max = 20) {
  const rows = await apiGet('/api/comments/search', {
    link_id: `t3_${postId}`,
    limit: 100
  });
  return rows
    .filter((c) => !c.parent_id || String(c.parent_id).startsWith('t3_')) // top-level only
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, max)
    .map((c) => ({
      id: c.id,
      author: c.author,
      score: c.score || 0,
      body: (c.body || '').slice(0, 3000)
    }));
}

module.exports = { fetchPosts, fetchTopComments };
