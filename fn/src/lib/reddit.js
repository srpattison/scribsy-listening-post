'use strict';

// Minimal Reddit API client — app-only OAuth (client_credentials), public read.
// Rate limit: 100 QPM with OAuth. We self-throttle to ~1 req/700ms.

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';

let cachedToken = null; // { token, expiresAt }

function userAgent() {
  return process.env.REDDIT_USER_AGENT || 'azure:scribsy-listening-post:1.0 (research; by /u/scribsy)';
}

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not configured');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent()
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`Reddit token request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(path, params = {}) {
  const token = await getToken();
  const url = new URL(API_BASE + path);
  url.searchParams.set('raw_json', '1');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  await sleep(700); // self-throttle under 100 QPM
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent() }
  });
  if (res.status === 429) {
    await sleep(15_000);
    return apiGet(path, params);
  }
  if (!res.ok) throw new Error(`Reddit GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function normalizePost(child) {
  const d = child.data;
  return {
    id: d.id,
    subreddit: d.subreddit,
    title: d.title || '',
    selftext: (d.selftext || '').slice(0, 12_000),
    author: d.author,
    score: d.score,
    upvote_ratio: d.upvote_ratio,
    num_comments: d.num_comments,
    created_utc: d.created_utc,
    permalink: 'https://www.reddit.com' + d.permalink,
    flair: d.link_flair_text || null,
    is_self: d.is_self
  };
}

// Fetch one listing page. listing: 'new' | 'top' | 'search'
async function fetchListing(subreddit, listing, { after, t, q, limit = 100 } = {}) {
  let path, params;
  if (listing === 'search') {
    path = `/r/${subreddit}/search`;
    params = { q, restrict_sr: 'on', sort: 'new', t: t || 'year', limit, after };
  } else {
    path = `/r/${subreddit}/${listing}`;
    params = { limit, after, t: listing === 'top' ? t || 'year' : undefined };
  }
  const data = await apiGet(path, params);
  const children = (data && data.data && data.data.children) || [];
  return {
    posts: children.filter((c) => c.kind === 't3').map(normalizePost),
    after: data.data ? data.data.after : null
  };
}

// Top-level comments for a post (up to `max`, sorted by top).
async function fetchTopComments(subreddit, postId, max = 20) {
  const data = await apiGet(`/r/${subreddit}/comments/${postId}`, { sort: 'top', limit: max, depth: 1 });
  const listing = Array.isArray(data) && data[1] ? data[1] : null;
  if (!listing || !listing.data || !listing.data.children) return [];
  return listing.data.children
    .filter((c) => c.kind === 't1')
    .slice(0, max)
    .map((c) => ({
      id: c.data.id,
      author: c.data.author,
      scoreAtCapture: c.data.score,
      body: (c.data.body || '').slice(0, 3000)
    }));
}

module.exports = { fetchListing, fetchTopComments };
