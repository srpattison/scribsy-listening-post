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
const config = require('../lib/config');

const OVERLAP_SECONDS = 3 * 24 * 3600; // re-scan window for Arctic late arrivals

// Throws if SUBREDDITS is unset — never falls back to a stale list (§9.1).
const subreddits = () => config.subreddits();

async function getWatermark(key) {
  const w = await store.getAggregate('watermark', key);
  return (w && w.utc) || Math.floor(Date.now() / 1000) - 14 * 24 * 3600; // first run: 14 days
}
const setWatermark = (key, utc) => store.saveAggregate('watermark', key, { utc });

async function admitPost(context, post, comments, counters) {
  // Per-post isolation: one malformed or unstorable post must not abandon the
  // rest of the sub's page — that would strand the watermark and silently stop
  // ingesting that sub. Same disease as the rollup's missing section guards.
  try {
    const isNew = await store.upsertPost(post);
    if (!isNew) return;
    await store.saveRaw(post, comments);
    await store.enqueueAnalysis({ subreddit: post.subreddit, id: post.id, created_utc: post.created_utc });
    counters.enqueued++;
  } catch (e) {
    counters.postErrors = (counters.postErrors || 0) + 1;
    if (!counters.firstPostError) counters.firstPostError = `${post && post.id}: ${e.message}`;
    context.warn(`admit failed for ${post && post.subreddit}/${post && post.id}: ${e.message}`);
  }
}

async function ingestRedditArctic(context, counters) {
  const minComments = parseInt(process.env.MIN_COMMENTS_FOR_FETCH || '3', 10);
  const { requestBackfill } = require('./backfill');
  for (const sub of subreddits()) {
    try {
      // New-sub detection: a sub with no backfill history gets its archive
      // walk queued automatically — adding to SUBREDDITS is the only step.
      const bfStatus = await store.getAggregate('backfill-status', sub.toLowerCase());
      if (!bfStatus) {
        const r = await requestBackfill(sub, 12);
        if (r.queued) context.log(`new subreddit detected — backfill queued for r/${sub}`);
      }
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
            ? await arctic.fetchPostComments(post.id, 20).catch(() => [])
            : [];
          await admitPost(context, post, comments, counters);
        }
        after = posts[posts.length - 1].created_utc;
        if (posts.length < 100) break;
      }
      await setWatermark(wmKey, newest);
      counters.subsWatermarked.push(sub);
    } catch (e) {
      counters.subsFailed.push({ sub, error: e.message });
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
          ? await bsky.fetchPostComments(post.uri, 20).catch(() => [])
          : [];
        await admitPost(context, post, comments, counters);
      }
      await setWatermark(wmKey, newest);
    } catch (e) {
      (counters.streamsFailed = counters.streamsFailed || []).push({ stream: stream.name, error: e.message });
      context.error(`bluesky ingest ${stream.name} failed: ${e.message}`);
    }
  }
}

async function runIngest(context, { pagesPerSub = 2 } = {}) {
  const startedMs = Date.now();
  await store.ensureInfra();
  const counters = {
    discovered: 0, enqueued: 0, postErrors: 0, firstPostError: null,
    subsAttempted: 0, subsWatermarked: [], subsFailed: []
  };
  const mode = process.env.REDDIT_MODE || 'arctic';
  counters.subsAttempted = subreddits().length;
  // Each frame is isolated: a total Reddit outage must not skip Bluesky.
  if (mode === 'oauth') {
    try { await ingestRedditOauth(context, counters, pagesPerSub); }
    catch (e) { context.error(`reddit oauth frame failed: ${e.message}`); counters.redditFrameError = e.message; }
  } else if (mode !== 'off') {
    try { await ingestRedditArctic(context, counters); }
    catch (e) { context.error(`reddit arctic frame failed: ${e.message}`); counters.redditFrameError = e.message; }
  }
  try { await ingestBluesky(context, counters); }
  catch (e) { context.error(`bluesky frame failed: ${e.message}`); counters.blueskyFrameError = e.message; }

  counters.durationMs = Date.now() - startedMs;
  counters.ok = counters.subsFailed.length === 0 && !counters.redditFrameError && !counters.blueskyFrameError;
  context.log(
    `ingest done: ${counters.discovered} seen, ${counters.enqueued} new enqueued, ` +
    `${counters.subsWatermarked.length}/${counters.subsAttempted} subs watermarked, ` +
    `${counters.subsFailed.length} subs failed, ${counters.postErrors} post errors`
  );
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
    // Same contract as rollupNow: always a readable JSON body, never empty.
    try {
      const result = await runIngest(context, { pagesPerSub: Math.min(pages, 10) });
      return { status: result.ok ? 200 : 207, jsonBody: result };
    } catch (e) {
      context.error(`ingest aborted: ${e.message}`);
      return { status: 500, jsonBody: { ok: false, error: e.message, failedAt: new Date().toISOString() } };
    }
  }
});
