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
const config = require('../lib/config');
const { mentionsAi } = require('../lib/taxonomy');

// r/SubName extraction. For comments this runs at INGEST, because comment
// analysis is gated behind COMMENT_ANALYZE_POLICY and may never run — the
// discovery card must not depend on paying to analyze (§3a.7).
function extractSubMentions(text, selfSub) {
  const mentions = new Set();
  for (const m of String(text || '').matchAll(/\br\/([A-Za-z0-9_]{3,21})\b/g)) {
    const name = m[1].toLowerCase();
    if (name !== String(selfSub || '').toLowerCase()) mentions.add(name);
  }
  return [...mentions].slice(0, 30).join(',');
}

async function admit(post, comments, counters) {
  const isNew = await store.upsertPost(post);
  if (!isNew) return;
  await store.saveRaw(post, comments);
  await store.enqueueAnalysis({
    subreddit: post.subreddit, id: post.id, created_utc: post.created_utc, kind: post.kind || 'post'
  });
  counters.enqueued++;
}

// Comments are archived unconditionally and enqueued for the analyzer, which
// applies COMMENT_ANALYZE_POLICY. Under the shipped `ingest-only` default the
// analyzer records and drops them without a model call.
async function admitComment(comment, counters) {
  comment.aiPrefilterHit = mentionsAi(comment.selftext);
  comment.subMentionsCsv = extractSubMentions(comment.selftext, comment.subreddit);
  const isNew = await store.upsertPost(comment);
  if (!isNew) return;
  await store.saveRaw(comment, []);
  await store.enqueueAnalysis({
    subreddit: comment.subreddit, id: comment.id, created_utc: comment.created_utc, kind: 'comment'
  });
  counters.enqueued++;
}

// Watermark namespaces are SEPARATE per walk kind. The post walks are complete
// 12-month walks and must never be restarted by a comment walk (§3a.4).
const watermarkKey = (sub, kind) =>
  (kind === 'comments' ? `backfill:reddit-comments:${sub.toLowerCase()}` : `backfill:reddit:${sub.toLowerCase()}`);
const statusKey = (sub, kind) =>
  (kind === 'comments' ? `comments:${sub.toLowerCase()}` : sub.toLowerCase());

// One time-budgeted chunk of the archive walk. Returns exhausted true/false.
async function backfillChunk(context, sub, months, kind = 'posts') {
  await store.ensureInfra();
  const minComments = parseInt(process.env.MIN_COMMENTS_FOR_FETCH || '3', 10);
  const counters = { sub, kind, seen: 0, enqueued: 0, exhausted: false };
  const startUtc = Math.floor(Date.now() / 1000) - months * 30 * 24 * 3600;
  const wmKey = watermarkKey(sub, kind);
  const saved = await store.getAggregate('watermark', wmKey);
  let after = (saved && saved.utc) || startUtc;

  const deadline = Date.now() + 6.5 * 60 * 1000; // conservative chunk budget
  let pages = 0;
  while (Date.now() < deadline && pages++ < 200) {
    let posts;
    try {
      posts = kind === 'comments'
        ? await arctic.fetchComments(sub, { afterUtc: after, limit: 100 })
        : await arctic.fetchPosts(sub, { afterUtc: after, limit: 100 });
    } catch (e) {
      context.error(`arctic backfill r/${sub} (${kind}) page failed: ${e.message}`);
      break; // requeue will retry this window later
    }
    if (!posts.length) { counters.exhausted = true; break; }
    for (const post of posts) {
      counters.seen++;
      try {
        if (kind === 'comments') {
          await admitComment(post, counters);
        } else {
          const comments = post.num_comments >= minComments
            ? await arctic.fetchPostComments(post.id, 20).catch(() => [])
            : [];
          await admit(post, comments, counters);
        }
      } catch (e) {
        counters.itemErrors = (counters.itemErrors || 0) + 1;
        context.warn(`backfill admit failed for ${sub}/${post && post.id}: ${e.message}`);
      }
    }
    after = posts[posts.length - 1].created_utc;
    await store.saveAggregate('watermark', wmKey, { utc: after });
    if (posts.length < 100) { counters.exhausted = true; break; }
  }
  counters.watermark = after;
  return counters;
}

async function markStatus(sub, patch, kind = 'posts') {
  const key = statusKey(sub, kind);
  const prev = (await store.getAggregate('backfill-status', key)) || {};
  await store.saveAggregate('backfill-status', key, { ...prev, ...patch, kind, updatedAt: new Date().toISOString() });
}

// Queue worker: process a chunk, then re-enqueue self until exhausted.
app.storageQueue('backfillWorker', {
  queueName: store.BACKFILL_QUEUE,
  connection: 'AzureWebJobsStorage',
  handler: async (message, context) => {
    const job = typeof message === 'string' ? JSON.parse(message) : message;
    const { sub, months = 12, kind = 'posts' } = job;
    const result = await backfillChunk(context, sub, months, kind);
    context.log(`backfill r/${sub} (${kind}): seen ${result.seen}, enqueued ${result.enqueued}, exhausted ${result.exhausted}`);
    if (result.exhausted) {
      await markStatus(sub, { exhausted: true, months }, kind);
    } else {
      await markStatus(sub, { exhausted: false, months, watermark: result.watermark }, kind);
      await store.enqueueBackfill({ sub, months, kind }, 30); // brief breather, then next chunk
    }
  }
});

// Enqueue a backfill job for a sub if none is already running/complete.
// Used by HTTP below and by the daily ingest's new-sub detection.
async function requestBackfill(sub, months = 12, force = false, kind = 'posts') {
  const status = await store.getAggregate('backfill-status', statusKey(sub, kind));
  if (!force && status && (status.exhausted || status.queued)) return { sub, kind, skipped: true, status };
  await markStatus(sub, { queued: true, exhausted: false, months }, kind);
  await store.enqueueBackfill({ sub, months, kind });
  return { sub, kind, queued: true };
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
          ? await bsky.fetchPostComments(post.uri, 20).catch(() => [])
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
    // `kind=comments` queues the comment walk. It is never queued automatically:
    // comment volume runs 10–40× submissions and the walk must be priced on one
    // sub before the rest are started (§10.3).
    const kind = params.get('kind') === 'comments' ? 'comments' : 'posts';
    if (stream) {
      return { jsonBody: await backfillBluesky(context) };
    }
    if (sub) {
      await store.ensureInfra();
      return { jsonBody: await requestBackfill(sub, months, force, kind) };
    }
    // Status view: one row per sub that has ever backfilled or been queued.
    let subs;
    try {
      subs = config.subreddits();
    } catch (e) {
      return { status: 500, jsonBody: { error: e.message, setting: e.setting } };
    }
    const status = {};
    for (const s of subs) {
      status[s] = {
        posts: (await store.getAggregate('backfill-status', statusKey(s, 'posts'))) || { neverStarted: true },
        comments: (await store.getAggregate('backfill-status', statusKey(s, 'comments'))) || { neverStarted: true }
      };
    }
    return {
      jsonBody: {
        note: 'POST ?sub=<name>&months=12 to queue posts (self-driving); add &kind=comments for the comment walk; ?force=1 to re-queue; ?stream=all for bluesky',
        status
      }
    };
  }
});
