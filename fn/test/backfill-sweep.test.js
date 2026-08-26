'use strict';

// CB-LISTEN-CORRECT-1 §4 — the self-healing backfill sweep.
//
// The failure class: a self-requeuing walk whose continuation message was lost
// (host restart between dequeue and re-enqueue) sits at `queued: true,
// exhausted: false` forever — no error, no poison message, no alert. Live
// casualties 2026-08-23: ao3 (a year short), betteroffline, worldbuilding,
// writingcirclejerk (never started). The sweep re-enqueues the wake-up; the
// watermark makes that a RESUME, never a restart.
//
// Acceptance bar (§7.5–7.6): implemented, idempotent, logged, threshold named
// — and the NEGATIVE CONTROL: `exhausted: true` must NOT be re-enqueued.

const test = require('node:test');
const assert = require('node:assert');

const sweep = require('../src/lib/backfill-sweep');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-08-26T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function fakeStore({ statuses = {} } = {}) {
  const aggregates = new Map();
  for (const [key, value] of Object.entries(statuses)) {
    aggregates.set(`backfill-status|${key}`, value);
  }
  const enqueued = [];
  return {
    aggregates,
    enqueued,
    async getAggregate(p, k) { return aggregates.get(`${p}|${k}`) ?? null; },
    async saveAggregate(p, k, v) { aggregates.set(`${p}|${k}`, v); },
    async listAggregates(p) {
      return [...aggregates.entries()]
        .filter(([key]) => key.startsWith(`${p}|`))
        .map(([key, v]) => ({ period: key.split('|')[1], ...v }));
    },
    async enqueueBackfill(job) { enqueued.push(job); },
    async queueDepth() { return 0; },
    BACKFILL_QUEUE: 'backfill-jobs'
  };
}

function collectingContext() {
  const warned = [];
  return { warned, log() {}, warn(m) { warned.push(m); }, error() {} };
}

// The live orphan shape, verbatim from the 2026-08-23 read: queued, not
// exhausted, updatedAt frozen days ago.
const orphanStatus = (over = {}) => ({
  queued: true, exhausted: false, months: 12, kind: 'posts',
  watermark: 1755988559, updatedAt: iso(NOW - 10 * 24 * HOUR), ...over
});

test('§7.5: an orphaned walk (queued, unexhausted, stale) is re-enqueued as a resume, with the re-enqueue logged and recorded', async () => {
  const store = fakeStore({ statuses: { ao3: orphanStatus() } });
  const context = collectingContext();
  const summary = await sweep.sweepOrphanedBackfills({
    store, context, subs: ['AO3'], staleHours: 24, now: () => NOW
  });

  assert.deepStrictEqual(store.enqueued, [{ sub: 'AO3', months: 12, kind: 'posts' }],
    'exactly one wake-up message, carrying the walk\'s own months window');
  assert.strictEqual(summary.requeued.length, 1);
  assert.strictEqual(summary.requeued[0].watermark, 1755988559,
    'the watermark rides along in the summary — proof this is a resume, not a restart');
  assert.ok(context.warned.some((m) => m.includes('re-enqueued orphaned posts walk for r/AO3')),
    'every re-enqueue must be logged — a self-heal that heals silently hides a recurring fault');

  const status = await store.getAggregate('backfill-status', 'ao3');
  assert.ok(status.sweepRequeuedAt, 'the sweep must record when it re-enqueued');
  assert.strictEqual(status.sweepRequeueCount, 1);
  assert.strictEqual(status.updatedAt, orphanStatus().updatedAt,
    'updatedAt means "the worker made chunk progress" and the sweep must not counterfeit it');
});

test('§7.6 NEGATIVE CONTROL: a walk at exhausted: true is NOT re-enqueued, however stale its row', async () => {
  const store = fakeStore({
    statuses: {
      writing: { queued: true, exhausted: true, months: 12, watermark: 1786000000, updatedAt: iso(NOW - 400 * 24 * HOUR) }
    }
  });
  const summary = await sweep.sweepOrphanedBackfills({
    store, context: collectingContext(), subs: ['writing'], staleHours: 24, now: () => NOW
  });
  assert.deepStrictEqual(store.enqueued, [], 'a finished walk must never be woken — 19 of 23 subs sit in exactly this state');
  assert.strictEqual(summary.skipped.exhausted, 1);
  assert.strictEqual(summary.requeued.length, 0);
});

test('idempotency (live chain): fresh updatedAt means a chain is running — no second message may be enqueued over it', async () => {
  const store = fakeStore({
    statuses: { worldbuilding: orphanStatus({ updatedAt: iso(NOW - 5 * 60 * 1000) }) } // 5 minutes ago: mid-walk
  });
  const summary = await sweep.sweepOrphanedBackfills({
    store, context: collectingContext(), subs: ['worldbuilding'], staleHours: 24, now: () => NOW
  });
  assert.deepStrictEqual(store.enqueued, []);
  assert.strictEqual(summary.skipped.fresh, 1);
});

test('idempotency (double sweep): a second sweep inside the threshold window skips the sub it just re-enqueued', async () => {
  const store = fakeStore({ statuses: { ao3: orphanStatus() } });
  const context = collectingContext();
  await sweep.sweepOrphanedBackfills({ store, context, subs: ['ao3'], staleHours: 24, now: () => NOW });
  assert.strictEqual(store.enqueued.length, 1);

  // Manual ingestNow an hour after the timer: the walk still has not started
  // (updatedAt unchanged), but sweepRequeuedAt is recent — no duplicate.
  await sweep.sweepOrphanedBackfills({ store, context, subs: ['ao3'], staleHours: 24, now: () => NOW + HOUR });
  assert.strictEqual(store.enqueued.length, 1, 'a restart storm must not become a duplicate-work storm');

  // But if the wake-up itself was ALSO lost, the next day's sweep tries again.
  await sweep.sweepOrphanedBackfills({ store, context, subs: ['ao3'], staleHours: 24, now: () => NOW + 25 * HOUR });
  assert.strictEqual(store.enqueued.length, 2, 'the sweep must keep healing across days, not give up after one attempt');
  assert.strictEqual((await store.getAggregate('backfill-status', 'ao3')).sweepRequeueCount, 2);
});

test('a walk that never started (queued, no watermark — the writingcirclejerk shape) gets a fresh seed', async () => {
  const store = fakeStore({
    statuses: { writingcirclejerk: { queued: true, exhausted: false, months: 12, updatedAt: iso(NOW - 10 * 24 * HOUR) } }
  });
  const summary = await sweep.sweepOrphanedBackfills({
    store, context: collectingContext(), subs: ['writingcirclejerk'], staleHours: 24, now: () => NOW
  });
  assert.deepStrictEqual(store.enqueued, [{ sub: 'writingcirclejerk', months: 12, kind: 'posts' }]);
  assert.strictEqual(summary.requeued[0].watermark, null,
    'no watermark = the worker starts from the top of its window, which IS the fresh seed');
});

test('a status row with no readable timestamp at all is treated as stale, not skipped forever', async () => {
  const store = fakeStore({ statuses: { betteroffline: { queued: true, exhausted: false, months: 12 } } });
  await sweep.sweepOrphanedBackfills({
    store, context: collectingContext(), subs: ['betteroffline'], staleHours: 24, now: () => NOW
  });
  assert.strictEqual(store.enqueued.length, 1);
});

test('subs with no backfill history are the seeder\'s job, not the sweep\'s; unqueued and unreadable rows are skipped and counted', async () => {
  const store = fakeStore({
    statuses: {
      writing: { queued: false, exhausted: false, months: 12, updatedAt: iso(NOW - 10 * 24 * HOUR) },
      pubtips: { error: 'row corrupt' }
    }
  });
  const context = collectingContext();
  const summary = await sweep.sweepOrphanedBackfills({
    store, context, subs: ['brandnewsub', 'writing', 'pubtips'], staleHours: 24, now: () => NOW
  });
  assert.deepStrictEqual(store.enqueued, []);
  assert.ok(summary.skipped.noHistory >= 1, 'the daily ingest\'s new-sub detection owns first seeding');
  assert.strictEqual(summary.skipped.notQueued, 1);
  assert.strictEqual(summary.skipped.unreadable, 1);
  assert.ok(context.warned.some((m) => m.includes('unreadable')), 'an unreadable status row is surfaced, never silently passed over');
});

test('the comment-walk namespace is swept independently and its status key never collides with the post walk', async () => {
  const store = fakeStore({
    statuses: {
      'ao3': orphanStatus({ exhausted: true, updatedAt: iso(NOW - 10 * 24 * HOUR) }), // posts: done
      'comments:ao3': orphanStatus({ kind: 'comments' }) // comments: orphaned mid-walk
    }
  });
  await sweep.sweepOrphanedBackfills({
    store, context: collectingContext(), subs: ['ao3'], staleHours: 24, now: () => NOW
  });
  assert.deepStrictEqual(store.enqueued, [{ sub: 'ao3', months: 12, kind: 'comments' }],
    'only the orphaned comment walk wakes; the exhausted post walk stays finished');
});

test('the staleness threshold is a named constant with an env override, not a literal buried in a condition', () => {
  assert.strictEqual(sweep.BACKFILL_SWEEP_STALE_HOURS_DEFAULT, 24);
  const config = require('../src/lib/config');
  assert.strictEqual(config.backfillSweepStaleHours({}), sweep.BACKFILL_SWEEP_STALE_HOURS_DEFAULT);
  assert.strictEqual(config.backfillSweepStaleHours({ BACKFILL_SWEEP_STALE_HOURS: '48' }), 48);
  assert.strictEqual(config.backfillSweepStaleHours({ BACKFILL_SWEEP_STALE_HOURS: 'junk' }),
    sweep.BACKFILL_SWEEP_STALE_HOURS_DEFAULT, 'an unparseable threshold falls back to the default, never to zero');
});

// ---------------------------------------------------------------------------
// §6 — the health surface for orphan state
// ---------------------------------------------------------------------------

test('health: queued-not-exhausted walks are listed with staleness, sweep history, and the queue depth alongside', async () => {
  const store = fakeStore({
    statuses: {
      ao3: orphanStatus({ sweepRequeuedAt: iso(NOW - 2 * HOUR), sweepRequeueCount: 3 }),
      writing: { queued: true, exhausted: true, months: 12, updatedAt: iso(NOW - 10 * 24 * HOUR) },
      'comments:ao3': orphanStatus({ kind: 'comments' })
    }
  });
  const block = await sweep.orphanHealthBlock({ store, staleHours: 24, now: () => NOW });
  assert.strictEqual(block.unavailable, undefined);
  assert.strictEqual(block.queuedNotExhausted.length, 2, 'the exhausted walk is not an orphan');
  const posts = block.queuedNotExhausted.find((o) => o.kind === 'posts');
  const comments = block.queuedNotExhausted.find((o) => o.kind === 'comments');
  assert.strictEqual(posts.sub, 'ao3');
  assert.strictEqual(posts.sweepRequeueCount, 3);
  assert.strictEqual(posts.stale, false, 'swept two hours ago — inside the threshold, so not currently stale');
  assert.strictEqual(comments.sub, 'ao3');
  assert.strictEqual(comments.stale, true);
  assert.strictEqual(block.backfillQueueDepthApprox, 0,
    'depth 0 alongside listed orphans is the self-contradiction signal: work claimed outstanding, no message anywhere');
  assert.strictEqual(block.staleHours, 24);
});

test('REPO-3: a health block that cannot read storage says UNAVAILABLE — never a confidently-empty orphan list', async () => {
  const broken = {
    async listAggregates() { throw new Error('storage down'); },
    async queueDepth() { return null; },
    async getAggregate() { return null; },
    BACKFILL_QUEUE: 'backfill-jobs'
  };
  const block = await sweep.orphanHealthBlock({ store: broken, staleHours: 24, now: () => NOW });
  assert.strictEqual(block.unavailable, true);
  assert.match(block.error, /storage down/);
  assert.ok(!('queuedNotExhausted' in block), 'an empty list is also the healthy reading — it must not be fabricated from a failure');
});
