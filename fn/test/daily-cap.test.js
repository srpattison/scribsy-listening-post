'use strict';

// CB-LISTEN-REPO-7 §8n — DAILY_ANALYZE_CAP does not enforce under concurrency.
//
// analyze.js:159 (as of d0fd644) did:
//   const counter = await store.getAggregate('analyze-counter', today);   // stale read
//   ...await analyzePost(...)...                                          // AOAI round trip
//   await store.saveAggregate('analyze-counter', today, { count: counter.count + 1 }); // blind write
//
// Sixteen concurrent handlers (batchSize=16) reading the same stale `count`
// and all writing `count + 1` collapses into roughly one effective increment
// per batch — the effective ceiling becomes DAILY_ANALYZE_CAP × concurrency,
// not DAILY_ANALYZE_CAP. Measured: 56,400 spent against a 20,000 cap on
// 2026-08-16, a 2.8x overrun.
//
// Fixed via optimistic-concurrency (ETag) compare-and-swap (lib/cas.js) with
// reserve-before-spend admission control (lib/daily-cap.js, lib/analyze-worker.js):
// every caller atomically claims the NEXT ticket number, and only THEN checks
// whether that ticket is within cap — so there is no read-then-check window
// for two handlers to both believe they are under cap.

const test = require('node:test');
const assert = require('node:assert');

const { casUpdate } = require('../src/lib/cas');
const { processAnalyzeJob } = require('../src/lib/analyze-worker');
const { createCache } = require('../src/lib/boilerplate-registry');

// Models one Table Storage row under REAL optimistic-concurrency semantics: a
// put() succeeds only if its etag matches what is currently stored, otherwise
// it conflicts (Table Storage's 412 / 409-on-create). `setImmediate` between
// get() and put() forces genuine interleaving instead of every call running
// to completion synchronously before the next starts.
function fakeRow() {
  let stored = { value: null, etag: null };
  return {
    async get() {
      await new Promise((r) => setImmediate(r));
      return { value: stored.value, etag: stored.etag };
    },
    async put(next, etag) {
      await new Promise((r) => setImmediate(r));
      if (etag !== stored.etag) {
        const e = new Error('etag mismatch');
        e.conflict = true;
        throw e;
      }
      stored = { value: next, etag: String(Number(stored.etag || 0) + 1) };
    }
  };
}

test('§8n: 200 interleaved CAS increments land exactly 200, not fewer', async () => {
  const backend = fakeRow();
  const K = 200;
  await Promise.all(Array.from({ length: K }, () =>
    casUpdate(backend, (prev) => ({ count: ((prev && prev.count) || 0) + 1 }))
  ));
  const final = await backend.get();
  assert.strictEqual(final.value.count, 200,
    'every one of 200 concurrent increments must be reflected; a lost increment reproduces the 2.8x overrun');
});

test('§8n: the same interleaving, done as a BLIND (non-retrying) read-modify-write, loses increments', () => {
  // Recreates analyze.js's pre-fix pattern verbatim — read, then write
  // count+1, with no conflict detection at all — to prove the interleaving
  // above genuinely produces races rather than the test being vacuous.
  return (async () => {
    const backend = fakeRow();
    const K = 200;
    let conflicts = 0;
    await Promise.all(Array.from({ length: K }, async () => {
      const { value, etag } = await backend.get();
      try {
        await backend.put({ count: ((value && value.count) || 0) + 1 }, etag);
      } catch (e) {
        if (!e.conflict) throw e;
        conflicts++; // a blind writer has nothing to retry with — this increment is lost
      }
    }));
    const final = await backend.get();
    assert.ok(conflicts > 0, 'the interleaving must actually produce races, or the test above proves nothing');
    assert.ok(final.value.count < K,
      `a blind (non-CAS) writer must lose increments under concurrency — got ${final.value.count}/${K}`);
  })();
});

// ---------------------------------------------------------------------------
// Reserve-before-spend: the cap must bound concurrent handlers, not just
// concurrent counter writes.
// ---------------------------------------------------------------------------

function fakeStoreForAnalyze() {
  const backends = new Map();
  const saved = [];
  const deferred = [];
  return {
    saved,
    deferred,
    async getRaw(subreddit, createdUtc, id) {
      return {
        post: { subreddit, title: `post ${id}`, selftext: 'body text', created_utc: createdUtc, kind: 'post' },
        comments: []
      };
    },
    async getPostRow() { return null; },
    async enqueueAnalysis(job, delay) { deferred.push({ job, delay }); },
    async saveAnalysis(subreddit, id, analysis, meta) { saved.push({ subreddit, id, analysis, meta }); },
    aggregateBackend(metric, period) {
      const key = `${metric}|${period}`;
      if (!backends.has(key)) backends.set(key, fakeRow());
      return backends.get(key);
    }
  };
}

function spyChat(calls) {
  return async () => {
    calls.push(1);
    await new Promise((r) => setImmediate(r)); // simulate a real round trip
    return { ai_related: true, stance_on_ai: 'na', topics: [], notable_quote: '', summary: '' };
  };
}

const noopContext = { log() {}, warn() {}, error() {} };

test('§8n: reserve-before-spend bounds concurrent AOAI calls at the daily cap', async () => {
  const prevCap = process.env.DAILY_ANALYZE_CAP;
  process.env.DAILY_ANALYZE_CAP = '5';
  try {
    const N = 5;
    const K = 20; // K > N concurrent handlers
    const storeImpl = fakeStoreForAnalyze();
    const registryCache = createCache(storeImpl);
    const calls = [];
    const chat = spyChat(calls);

    await Promise.all(Array.from({ length: K }, (_, i) =>
      processAnalyzeJob(
        { subreddit: 'writing', id: `p${i}`, created_utc: 1_760_000_000, kind: 'post' },
        noopContext,
        { storeImpl, chat, registryCache }
      )
    ));

    assert.ok(calls.length <= N, `expected at most ${N} AOAI calls under a cap of ${N}, got ${calls.length} (of ${K} concurrent handlers)`);
    assert.strictEqual(calls.length + storeImpl.deferred.length, K,
      'every job must be either analyzed or deferred — none silently dropped');
  } finally {
    if (prevCap === undefined) delete process.env.DAILY_ANALYZE_CAP;
    else process.env.DAILY_ANALYZE_CAP = prevCap;
  }
});

// ---------------------------------------------------------------------------
// Same fix, applied to filter-counter and comment-gate (§8n requirement 4).
// ---------------------------------------------------------------------------

test('§8n: filter-counter and comment-gate survive 50 concurrent writers without losing counts', async () => {
  const dailyCap = require('../src/lib/daily-cap');
  const filterBackend = fakeRow();
  const gateBackend = fakeRow();
  const K = 50;

  await Promise.all(Array.from({ length: K }, () =>
    dailyCap.recordFiltered(filterBackend, { 'automod-author': 1, 'registry-hash': 2 })
  ));
  const filterFinal = await filterBackend.get();
  assert.strictEqual(filterFinal.value.total, K * 3);
  assert.strictEqual(filterFinal.value.byReason['automod-author'], K);
  assert.strictEqual(filterFinal.value.byReason['registry-hash'], K * 2);

  await Promise.all(Array.from({ length: K }, () => dailyCap.bumpCommentCounter(gateBackend, 'analyzed')));
  const gateFinal = await gateBackend.get();
  assert.strictEqual(gateFinal.value.analyzed, K);
});
