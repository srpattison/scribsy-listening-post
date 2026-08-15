'use strict';

// Historical backfill, two frames.
//   Reddit (Arctic Shift): POST /api/backfill?sub=writing&months=12
//     — walks the archive ascending from N months back; one subreddit per
//       invocation (consumption-plan timeout); deploy.sh loops the list.
//       Multiple invocations resume from a per-sub backfill watermark.
//   Bluesky:               POST /api/backfill?stream=all
//     — pages each query stream back as far as search paging allows.

const { app } = require('@azure/functions');
const arctic = require('../lib/sources/arcticshift');
const bsky = require('../lib/sources/bluesky');
const store = require('../lib/store');
const { DEFAULT_SUBREDDITS } = require('../lib/taxonomy');

async function admit(post, comments, counters) {
  const isNew = await store.upsertPost(post);
  if (!isNew) return;
  await store.saveRaw(post, comments);
  await store.enqueueAnalysis({ subreddit: post.subreddit, id: post.id, created_utc: post.created_utc });
  counters.enqueued++;
}

async function backfillArcticSub(context, sub, months) {
  await store.ensureInfra();
  const minComments = parseInt(process.env.MIN_COMMENTS_FOR_FETCH || '3', 10);
  const counters = { sub, seen: 0, enqueued: 0, resumedFrom: null, exhausted: false };
  const startUtc = Math.floor(Date.now() / 1000) - months * 30 * 24 * 3600;
  const wmKey = `backfill:reddit:${sub.toLowerCase()}`;
  const saved = await store.getAggregate('watermark', wmKey);
  let after = (saved && saved.utc) || startUtc;
  counters.resumedFrom = after;

  // ~7.5 min budget inside the 9-min function timeout
  const deadline = Date.now() + 7.5 * 60 * 1000;
  let pages = 0;
  while (Date.now() < deadline && pages++ < 200) {
    let posts;
    try {
      posts = await arctic.fetchPosts(sub, { afterUtc: after, limit: 100 });
    } catch (e) {
      context.error(`arctic backfill r/${sub} page failed: ${e.message}`);
      break;
    }
    if (!posts.length) { counters.exhausted = true; break; }
    for (const post of posts) {
      counters.seen++;
      const comments = post.num_comments >= minComments
        ? await arctic.fetchTopComments(post.id, 20).catch(() => [])
        : [];
      await admit(post, comments, counters);
    }
    after = posts[posts.length - 1].created_utc;
    await store.saveAggregate('watermark', wmKey, { utc: after });
    if (posts.length < 100) { counters.exhausted = true; break; }
  }
  counters.nextAfter = after;
  return counters;
}

async function backfillBluesky(context) {
  await store.ensureInfra();
  const minReplies = parseInt(process.env.BSKY_MIN_REPLIES_FOR_FETCH || '2', 10);
  const counters = { streams: 0, seen: 0, enqueued: 0 };
  for (const stream of bsky.streams()) {
    counters.streams++;
    try {
      const posts = await bsky.searchStream(stream, { maxPages: 10 });
      for (const post of posts) {
        counters.seen++;
        const comments = post.num_comments >= minReplies
          ? await bsky.fetchTopComments(post.uri, 20).catch(() => [])
          : [];
        await admit(post, comments, counters);
      }
    } catch (e) {
      context.error(`bluesky backfill ${stream.name} failed: ${e.message}`);
    }
  }
  return counters;
}

app.http('backfill', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    const params = new URL(request.url).searchParams;
    const sub = params.get('sub');
    const stream = params.get('stream');
    const months = Math.min(parseInt(params.get('months') || '12', 10), 24);
    if (stream) {
      return { jsonBody: await backfillBluesky(context) };
    }
    if (sub) {
      const result = await backfillArcticSub(context, sub, months);
      if (!result.exhausted) result.note = 'time budget hit — call again with the same sub to resume from the watermark';
      return { jsonBody: result };
    }
    const subs = process.env.SUBREDDITS
      ? process.env.SUBREDDITS.split(',').map((s) => s.trim())
      : DEFAULT_SUBREDDITS;
    return {
      jsonBody: {
        message: 'reddit: POST /api/backfill?sub=<name>&months=12 (repeat per sub, re-call to resume) · bluesky: POST /api/backfill?stream=all',
        subs
      }
    };
  }
});
