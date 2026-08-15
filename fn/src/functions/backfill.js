'use strict';

// Historical backfill — SELF-DRIVING as of round 2.
//
// A backfill is a queue job {sub, months} on `backfill-jobs`. The worker
// processes one time-budgeted chunk of the Arctic Shift archive walk, saves
// the watermark, and re-enqueues ITSELF until the walk is exhausted — no
// external loop, no babysitting, survives restarts (the watermark is the
// state, the queue message is just a wake-up call).
//
// Jobs are created two ways:
//   - automatically: daily ingest enqueues a job for any subreddit that has
//     no backfill history (i.e. newly added to SUBREDDITS)
//   - manually:      POST /api/backfill?sub=<name>&months=12  (just enqueues)
// Bluesky backfill stays synchronous (fast): POST /api/backfill?stream=all
// Status: GET-style POST /api/backfill with no params returns per-sub status.

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

// One time-budgeted chunk of the archive walk. Returns exhausted true/false.
async function backfillChunk(context, sub, months) {
  await store.ensureInfra();
  const minComments = parseInt(process.env.MIN_COMMENTS_FOR_FETCH || '3', 10);
  const counters = { sub, seen: 0, enqueued: 0, exhausted: false };
  const startUtc = Math.floor(Date.now() / 1000) - months * 30 * 24 * 3600;
  const wmKey = `backfill:reddit:${sub.toLowerCase()}`;
  const saved = await store.getAggregate('watermark', wmKey);
  let after = (saved && saved.utc) || startUtc;

  const deadline = Date.now() + 6.5 * 60 * 1000; // conservative chunk budget
  let pages = 0;
  while (Date.now() < deadline && pages++ < 200) {
    let posts;
    try {
      posts = await arctic.fetchPosts(sub, { afterUtc: after, limit: 100 });
    } catch (e) {
      context.error(`arctic backfill r/${sub} page failed: ${e.message}`);
      break; // requeue will retry this window later
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
  counters.watermark = after;
  return counters;
}

async function markStatus(sub, patch) {
  const key = sub.toLowerCase();
  const prev = (await store.getAggregate('backfill-status', key)) || {};
  await store.saveAggregate('backfill-status', key, { ...prev, ...patch, updatedAt: new Date().toISOString() });
}

// Queue worker: process a chunk, then re-enqueue self until exhausted.
app.storageQueue('backfillWorker', {
  queueName: store.BACKFILL_QUEUE,
  connection: 'AzureWebJobsStorage',
  handler: async (message, context) => {
    const job = typeof message === 'string' ? JSON.parse(message) : message;
    const { sub, months = 12 } = job;
    const result = await backfillChunk(context, sub, months);
    context.log(`backfill r/${sub}: seen ${result.seen}, enqueued ${result.enqueued}, exhausted ${result.exhausted}`);
    if (result.exhausted) {
      await markStatus(sub, { exhausted: true, months });
    } else {
      await markStatus(sub, { exhausted: false, months, watermark: result.watermark });
      await store.enqueueBackfill({ sub, months }, 30); // brief breather, then next chunk
    }
  }
});

// Enqueue a backfill job for a sub if none is already running/complete.
// Used by HTTP below and by the daily ingest's new-sub detection.
async function requestBackfill(sub, months = 12, force = false) {
  const status = await store.getAggregate('backfill-status', sub.toLowerCase());
  if (!force && status && (status.exhausted || status.queued)) return { sub, skipped: true, status };
  await markStatus(sub, { queued: true, exhausted: false, months });
  await store.enqueueBackfill({ sub, months });
  return { sub, queued: true };
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

module.exports = { requestBackfill };

app.http('backfill', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    const params = new URL(request.url).searchParams;
    const sub = params.get('sub');
    const stream = params.get('stream');
    const months = Math.min(parseInt(params.get('months') || '12', 10), 24);
    const force = params.get('force') === '1';
    if (stream) {
      return { jsonBody: await backfillBluesky(context) };
    }
    if (sub) {
      await store.ensureInfra();
      return { jsonBody: await requestBackfill(sub, months, force) };
    }
    // Status view: one row per sub that has ever backfilled or been queued.
    const subs = process.env.SUBREDDITS
      ? process.env.SUBREDDITS.split(',').map((s) => s.trim())
      : DEFAULT_SUBREDDITS;
    const status = {};
    for (const s of subs) {
      status[s] = (await store.getAggregate('backfill-status', s.toLowerCase())) || { neverStarted: true };
    }
    return { jsonBody: { note: 'POST ?sub=<name>&months=12 to queue (self-driving); ?force=1 to re-queue; ?stream=all for bluesky', status } };
  }
});
