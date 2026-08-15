'use strict';

// Daily two-frame ingest.
//   Frame 1 (deep, lagged):  Reddit via Arctic Shift — watermark + 3-day overlap
//                            re-query absorbs the archive's late arrivals.
//   Frame 2 (fast, skewed):  Bluesky query streams via the open AppView API.
//   (Dormant: official Reddit OAuth — REDDIT_MODE=oauth if approval ever lands.)
// Timer 06:10 ET (10:10 UTC) + manual HTTP trigger.

const { app } = require('@azure/functions');
const arctic = require('../lib/sources/arcticshift');
const bsky = require('../lib/sources/bluesky');
const redditOauth = require('../lib/reddit');
const store = require('../lib/store');
const { DEFAULT_SUBREDDITS } = require('../lib/taxonomy');

const OVERLAP_SECONDS = 3 * 24 * 3600; // re-scan window for Arctic late arrivals

function subreddits() {
  const s = process.env.SUBREDDITS;
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : DEFAULT_SUBREDDITS;
}

async function getWatermark(key) {
  const w = await store.getAggregate('watermark', key);
  return (w && w.utc) || Math.floor(Date.now() / 1000) - 14 * 24 * 3600; // first run: 14 days
}
const setWatermark = (key, utc) => store.saveAggregate('watermark', key, { utc });

async function admitPost(context, post, comments, counters) {
  const isNew = await store.upsertPost(post);
  if (!isNew) return;
  await store.saveRaw(post, comments);
  await store.enqueueAnalysis({ subreddit: post.subreddit, id: post.id, created_utc: post.created_utc });
  counters.enqueued++;
}

async function ingestRedditArctic(context, counters) {
  const minComments = parseInt(process.env.MIN_COMMENTS_FOR_FETCH || '3', 10);
  for (const sub of subreddits()) {
    try {
      const wmKey = `reddit:${sub.toLowerCase()}`;
      const from = (await getWatermark(wmKey)) - OVERLAP_SECONDS;
      let after = from, newest = from, pages = 0;
      while (pages++ < 12) {
        const posts = await arctic.fetchPosts(sub, { afterUtc: after, limit: 100 });
        if (!posts.length) break;
        for (const post of posts) {
          counters.discovered++;
          newest = Math.max(newest, post.created_utc);
          const comments = post.num_comments >= minComments
            ? await arctic.fetchTopComments(post.id, 20).catch(() => [])
            : [];
          await admitPost(context, post, comments, counters);
        }
        after = posts[posts.length - 1].created_utc;
        if (posts.length < 100) break;
      }
      await setWatermark(wmKey, newest);
    } catch (e) {
      context.error(`arctic ingest r/${sub} failed: ${e.message}`);
    }
  }
}

async function ingestRedditOauth(context, counters, pagesPerSub) {
  const minComments = parseInt(process.env.MIN_COMMENTS_FOR_FETCH || '3', 10);
  for (const sub of subreddits()) {
    try {
      let after = null;
      for (let page = 0; page < pagesPerSub; page++) {
        const { posts, after: next } = await redditOauth.fetchListing(sub, 'new', { after });
        for (const post of posts) {
          counters.discovered++;
          post.source = 'reddit';
          const comments = post.num_comments >= minComments
            ? await redditOauth.fetchTopComments(post.subreddit, post.id, 20)
            : [];
          await admitPost(context, post, comments, counters);
        }
        after = next;
        if (!after) break;
      }
    } catch (e) {
      context.error(`oauth ingest r/${sub} failed: ${e.message}`);
    }
  }
}

async function ingestBluesky(context, counters) {
  const minReplies = parseInt(process.env.BSKY_MIN_REPLIES_FOR_FETCH || '2', 10);
  for (const stream of bsky.streams()) {
    try {
      const wmKey = `bsky:${stream.name}`;
      const from = await getWatermark(wmKey);
      const posts = await bsky.searchStream(stream, { sinceUtc: from, maxPages: 3 });
      let newest = from;
      for (const post of posts) {
        counters.discovered++;
        newest = Math.max(newest, post.created_utc);
        const comments = post.num_comments >= minReplies
          ? await bsky.fetchTopComments(post.uri, 20).catch(() => [])
          : [];
        await admitPost(context, post, comments, counters);
      }
      await setWatermark(wmKey, newest);
    } catch (e) {
      context.error(`bluesky ingest ${stream.name} failed: ${e.message}`);
    }
  }
}

async function runIngest(context, { pagesPerSub = 2 } = {}) {
  await store.ensureInfra();
  const counters = { discovered: 0, enqueued: 0 };
  const mode = process.env.REDDIT_MODE || 'arctic';
  if (mode === 'oauth') await ingestRedditOauth(context, counters, pagesPerSub);
  else if (mode !== 'off') await ingestRedditArctic(context, counters);
  await ingestBluesky(context, counters);
  context.log(`ingest done: ${counters.discovered} seen, ${counters.enqueued} new enqueued`);
  return counters;
}

app.timer('ingestDaily', {
  schedule: '0 10 10 * * *', // 10:10 UTC daily
  handler: async (_timer, context) => {
    await runIngest(context);
  }
});

app.http('ingestNow', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    const pages = parseInt(new URL(request.url).searchParams.get('pages') || '2', 10);
    const result = await runIngest(context, { pagesPerSub: Math.min(pages, 10) });
    return { jsonBody: result };
  }
});
