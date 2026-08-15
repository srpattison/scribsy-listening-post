'use strict';

// Bluesky adapter — public AppView API, open by AT Protocol design (no key, no
// approval). This is the REAL-TIME frame: PR radar and flashpoint detection.
// SAMPLING NOTE (do not delete): the Bluesky writing community skews
// literary/professional and anti-AI relative to the general writer population.
// Rows from this source must never be pooled into population-level claims —
// rollup and the strategy brief treat it as a separate frame.

const BASE = () => (process.env.BLUESKY_BASE || 'https://public.api.bsky.app').replace(/\/+$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Default query streams. Override with BLUESKY_STREAMS app setting
// (JSON: [{ "name": "bsky-writing-ai", "q": "writing AI" }, ...]).
const DEFAULT_STREAMS = [
  { name: 'bsky-writing-ai', q: 'writing AI novel' },
  { name: 'bsky-ai-ethics', q: 'writers AI ethics' },
  { name: 'bsky-ai-slop', q: 'AI slop writing' },
  { name: 'bsky-ai-accused', q: 'accused AI writing' },
  { name: 'bsky-nanowrimo', q: 'nanowrimo' },
  { name: 'bsky-novel-november', q: '"novel november"' },
  { name: 'bsky-ai-disclosure', q: 'author AI disclosure' }
];

function streams() {
  try {
    const s = JSON.parse(process.env.BLUESKY_STREAMS || 'null');
    if (Array.isArray(s) && s.length) return s;
  } catch { /* fall through */ }
  return DEFAULT_STREAMS;
}

async function apiGet(path, params) {
  const url = new URL(BASE() + '/xrpc/' + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  await sleep(400);
  const res = await fetch(url, { headers: { 'User-Agent': 'scribsy-listening-post/1.0 (market research; steven@scribsy.ai)' } });
  if (res.status === 429) { await sleep(20_000); return apiGet(path, params); }
  if (!res.ok) throw new Error(`Bluesky ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function postIdFromUri(uri) {
  // at://did:plc:xxxx/app.bsky.feed.post/rkey → "did:plc:xxxx.rkey" (Table-key safe)
  const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/.exec(uri || '');
  return m ? `${m[1]}.${m[2]}` : (uri || '').replace(/[/\\#?]/g, '_');
}

function normalizePost(p, streamName) {
  const rec = p.record || {};
  const text = (rec.text || '').slice(0, 12_000);
  const rkey = (p.uri || '').split('/').pop();
  return {
    source: 'bluesky',
    subreddit: streamName, // community key = stream name
    id: postIdFromUri(p.uri),
    uri: p.uri,
    title: text.split('\n')[0].slice(0, 200),
    selftext: text,
    author: (p.author && (p.author.handle || p.author.did)) || 'unknown',
    score: (p.likeCount || 0) + (p.repostCount || 0),
    num_comments: p.replyCount || 0,
    created_utc: Math.floor(new Date(rec.createdAt || p.indexedAt || Date.now()).getTime() / 1000),
    permalink: p.author && p.author.handle && rkey
      ? `https://bsky.app/profile/${p.author.handle}/post/${rkey}`
      : p.uri,
    flair: null,
    is_self: true
  };
}

// Search one stream, newest first; client-side floor on createdAt.
async function searchStream(stream, { sinceUtc, maxPages = 3 } = {}) {
  const out = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const data = await apiGet('app.bsky.feed.searchPosts', {
      q: stream.q,
      sort: 'latest',
      limit: 100,
      cursor,
      since: sinceUtc ? new Date(sinceUtc * 1000).toISOString() : undefined
    });
    const posts = (data.posts || []).map((p) => normalizePost(p, stream.name));
    out.push(...posts);
    cursor = data.cursor;
    if (!cursor || posts.length === 0) break;
    if (sinceUtc && posts.every((p) => p.created_utc < sinceUtc)) break;
  }
  return sinceUtc ? out.filter((p) => p.created_utc >= sinceUtc) : out;
}

// Top-level replies to a post — the "comments" for stance-mix analysis.
async function fetchTopComments(uri, max = 20) {
  const data = await apiGet('app.bsky.feed.getPostThread', { uri, depth: 1 });
  const replies = (data.thread && data.thread.replies) || [];
  return replies
    .filter((r) => r.post && r.post.record)
    .map((r) => ({
      id: postIdFromUri(r.post.uri),
      author: (r.post.author && r.post.author.handle) || 'unknown',
      score: r.post.likeCount || 0,
      body: (r.post.record.text || '').slice(0, 3000)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

module.exports = { streams, searchStream, fetchTopComments, DEFAULT_STREAMS };
