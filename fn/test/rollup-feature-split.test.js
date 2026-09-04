'use strict';

// CB-LISTEN-BOARDS-1 §4.2 — the AI / non-AI feature split.
//
// Root cause (C3): rollup-engine.js's `features` section computes aiRelated
// correctly in the primary path (aoai.normalizeFeatures groups + majority
// vote), but when normalizeFeatures throws, the catch-block fallback rebuilds
// featureBoard from raw name counts with NO aiRelated field at all. Every
// entry then reads aiRelated: undefined, so the dashboard's AI bucket
// (`featureBoard.filter(x => x.aiRelated)`) is empty corpus-wide — exactly the
// reported "Nothing yet" — while the underlying rows are correct.

const test = require('node:test');
const assert = require('node:assert');

const { runRollup } = require('../src/lib/rollup-engine');

function fakeStore(rows) {
  const saved = new Map();
  return {
    saved,
    listAnalyzedPosts: async () => rows,
    saveAggregate: async (p, k, v) => { saved.set(p, { period: k, payload: v }); },
    getAggregate: async (p) => (saved.has(p) ? saved.get(p).payload : null)
  };
}

const silentContext = { log() {}, warn() {}, error() {} };
const TEST_ENV = { SUBREDDITS: 'writing', SUB_TAGS: '{}', BSKY_STREAMS: '[]' };

function row(i, feature) {
  return {
    partitionKey: i === 'aiwritinglounge' ? 'aiwritinglounge' : 'writing',
    rowKey: typeof i === 'string' ? i : 'id' + i,
    author: 'author' + i,
    permalink: '/r/writing/id' + i,
    createdUtc: 1_760_000_000,
    analysisJson: JSON.stringify({
      week: '2026-W33', ai_related: true, stance_on_ai: 'curious',
      feature_requests: [feature],
      notable_quote: '', summary: 's'
    })
  };
}

const brokenAoai = {
  normalizeFeatures: async () => { throw new Error('AOAI 429'); },
  synthesizePersonas: async () => ({ personas: [] }),
  strategyBrief: async () => ({ answers: [] }),
  standingQuestions: () => []
};

test('(a) the degraded fallback still carries a boolean aiRelated, with at least one true', async () => {
  const rows = [
    row(1, { feature: 'AI outline generator', ai_related: true, quote: 'q1' }),
    row(2, { feature: 'AI outline generator', ai_related: true, quote: 'q2' }),
    row(3, { feature: 'dark mode', ai_related: false, quote: 'q3' })
  ];
  const store = fakeStore(rows);
  await runRollup({ store, aoai: brokenAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z') });

  const features = store.saved.get('features').payload;
  assert.strictEqual(features.degraded, true);
  assert.ok(features.featureBoard.length > 0);
  for (const f of features.featureBoard) {
    assert.strictEqual(typeof f.aiRelated, 'boolean', `every entry must carry a boolean aiRelated, got ${JSON.stringify(f)}`);
  }
  assert.ok(features.featureBoard.some((f) => f.aiRelated === true),
    'at least one degraded-fallback entry must read aiRelated: true for a fixture that is majority ai_related');
});

test('(b) end-to-end on a fixture shaped like the real contaminated row: the AI bucket is non-empty', async () => {
  // PartitionKey=aiwritinglounge, RowKey=1uozxep — the shape recon cited.
  const rows = [
    { partitionKey: 'aiwritinglounge', rowKey: '1uozxep', author: 'writer1', permalink: '/r/aiwritinglounge/1uozxep',
      createdUtc: 1_760_000_000,
      analysisJson: JSON.stringify({
        week: '2026-W33', ai_related: true, stance_on_ai: 'enthusiastic',
        feature_requests: [{ feature: 'AI continuity checker', ai_related: true, quote: 'q' }],
        notable_quote: '', summary: 's'
      }) }
  ];
  const store = fakeStore(rows);
  await runRollup({ store, aoai: brokenAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z') });

  const features = store.saved.get('features').payload;
  const aiBucket = features.featureBoard.filter((f) => f.aiRelated);
  assert.ok(aiBucket.length > 0, 'the AI bucket must not be empty for a corpus that is entirely ai_related feature requests');
});

test('(c) degraded is reflected in rollup-health, not only inside the section payload', async () => {
  const rows = [row(1, { feature: 'AI outline generator', ai_related: true, quote: 'q1' })];
  const store = fakeStore(rows);
  const summary = await runRollup({ store, aoai: brokenAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z') });

  assert.ok(summary.featuresHealth, 'rollup-health summary must carry a featuresHealth block');
  assert.strictEqual(summary.featuresHealth.degraded, true);
  assert.match(summary.featuresHealth.degradedReason, /AOAI 429/);

  const health = store.saved.get('rollup-health').payload;
  assert.strictEqual(health.featuresHealth.degraded, true, 'the persisted rollup-health row must show the degradation too');
});

test('clusteredNames/totalNames record the slice(0, 400) truncation rather than hiding it', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(i, { feature: `feature ${i}`, ai_related: false, quote: 'q' }));
  const store = fakeStore(rows);
  const okAoai = {
    normalizeFeatures: async (names) => ({ groups: [{ canonical: names[0], members: names.map((_, i) => i) }] }),
    synthesizePersonas: async () => ({ personas: [] }),
    strategyBrief: async () => ({ answers: [] }),
    standingQuestions: () => []
  };
  await runRollup({ store, aoai: okAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z') });
  const features = store.saved.get('features').payload;
  assert.strictEqual(features.totalNames, 5);
  assert.strictEqual(features.clusteredNames, 5);
});
