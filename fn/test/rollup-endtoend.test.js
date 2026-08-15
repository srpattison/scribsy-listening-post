'use strict';

// End-to-end run of the real section list against fake storage/AOAI.
// Catches wiring mistakes the isolation unit tests cannot see: a section that
// references an undefined variable, a dependent section reading the wrong key,
// or a build() that throws on an empty corpus.

const test = require('node:test');
const assert = require('node:assert');

const { runRollup } = require('../src/lib/rollup-engine');

const ALL_SECTIONS = [
  'meta', 'heatmap', 'stance', 'distributions', 'features', 'minbar', 'trust',
  'cohort', 'quotes', 'personas', 'competitors', 'resonance', 'signals',
  'discovery', 'brief', 'snapshot'
];

function fakeStore(rows) {
  const saved = new Map();
  return {
    saved,
    listAnalyzedPosts: async () => rows,
    saveAggregate: async (p, k, v) => { saved.set(p, { period: k, payload: v }); },
    getAggregate: async (p) => (saved.has(p) ? saved.get(p).payload : null)
  };
}

const fakeAoai = {
  normalizeFeatures: async (names) => ({
    groups: names.length ? [{ canonical: names[0], members: names.map((_, i) => i) }] : []
  }),
  synthesizePersonas: async () => ({ personas: [{ name: 'The Wary Hobbyist', share_pct: 40 }] }),
  strategyBrief: async () => ({ answers: [{ question: 'q', answer: 'a', confidence: 'medium' }] }),
  standingQuestions: () => ['q1', 'q2']
};

const silentContext = { log() {}, warn() {}, error() {} };

// deploy.sh always sets these; config.js throws without them by design (§9.1).
const TEST_ENV = { SUBREDDITS: 'writing,writers', SUB_TAGS: '{}', BSKY_STREAMS: '[{"name":"bsky-writing","query":"writing","kind":"topic"}]' };

function row(i, over = {}) {
  return {
    partitionKey: over.sub || 'writing',
    rowKey: 'id' + i,
    source: over.source || 'reddit',
    title: 'post ' + i,
    author: 'author' + (i % 5),
    permalink: '/r/writing/id' + i,
    score: i,
    createdUtc: 1_760_000_000 + i,
    subMentionsCsv: 'fantasywriters,bookbinding,bookbinding',
    analysisJson: JSON.stringify({
      week: '2026-W3' + (i % 6),
      ai_related: true,
      stance_on_ai: ['hostile', 'wary', 'curious', 'pragmatic'][i % 4],
      stance_basis: ['craft-quality'],
      stance_intensity: i % 4,
      comment_stance_mix: { wary: 2, curious: 1 },
      persona: { experience: 'hobbyist', goal: 'finish a novel' },
      topics: ['craft-authenticity', 'provenance-proof', 'continuity-consistency'],
      pain_points: ['losing track of continuity'],
      expected_baseline: ['must not train on my words'],
      deal_breakers: [{ item: 'trains on my manuscript', kind: 'trust-privacy', quote: 'no thanks' }],
      trust_signals: [{ direction: 'breaks', signal: 'vague privacy policy', quote: 'unclear' }],
      feature_requests: [{ feature: 'continuity checker', ai_related: true, quote: 'want this' }],
      tools_mentioned: [{ tool: 'Sudowrite', sentiment: 'mixed', switching: true, context: 'left it' }],
      notable_quote: 'I want to prove I wrote this myself',
      summary: 'a writer worried about provenance',
      ...over.analysis
    }),
    ...over.row
  };
}

test('a full run writes every section and reports a clean summary', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(i));
  const store = fakeStore(rows);

  const summary = await runRollup({
    store,
    aoai: fakeAoai,
    context: silentContext,
    env: { SUBREDDITS: 'writing,writers', SUB_TAGS: '{"WritingWithAI":"enclave-pro"}' },
    now: () => new Date('2026-08-15T23:30:00.000Z')
  });

  assert.strictEqual(summary.ok, true, `sections failed: ${JSON.stringify(summary.sectionsFailed)}`);
  assert.deepStrictEqual(summary.sectionsFailed, []);
  assert.deepStrictEqual(summary.sectionsWritten, ALL_SECTIONS);
  assert.strictEqual(summary.rowsScanned, 40);
  assert.strictEqual(summary.rowsAnalyzed, 40);
  assert.strictEqual(summary.rowsSkipped, 0);
  assert.strictEqual(typeof summary.durationMs, 'number');

  // Not one of the 15 may come back null — the whole point of the round.
  for (const name of ALL_SECTIONS) {
    const saved = store.saved.get(name);
    assert.ok(saved, `${name} must be written`);
    assert.ok(saved.payload && typeof saved.payload === 'object', `${name} payload must be an object`);
    assert.strictEqual(saved.payload.error, undefined, `${name} must not be an error row`);
  }

  // Spot-check that content actually computed rather than defaulting to empty.
  assert.strictEqual(store.saved.get('meta').payload.totalPosts, 40);
  assert.ok(store.saved.get('distributions').payload.stances.hostile > 0);
  assert.ok(store.saved.get('quotes').payload.quotes.length > 0);
  assert.ok(store.saved.get('minbar').payload.dealBreakerBoard.length > 0);
  assert.ok(store.saved.get('discovery').payload.candidates.some((c) => c.sub === 'bookbinding'));
  assert.strictEqual(store.saved.get('snapshot').period, '2026-08-15');
});

test('an empty corpus still writes every section instead of throwing', async () => {
  const store = fakeStore([]);
  const summary = await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z')
  });
  assert.strictEqual(summary.ok, true, `sections failed: ${JSON.stringify(summary.sectionsFailed)}`);
  assert.deepStrictEqual(summary.sectionsWritten, ALL_SECTIONS);
  assert.strictEqual(summary.rowsAnalyzed, 0);
});

test('a storage failure on one section does not stop the other fifteen', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(i));
  const store = fakeStore(rows);
  const realSave = store.saveAggregate;
  let firstAttempt = true;
  store.saveAggregate = async (p, k, v) => {
    // Reproduce the production failure exactly: the distributions write is
    // rejected for exceeding the property cap.
    if (p === 'distributions' && firstAttempt) { firstAttempt = false; throw new Error('PropertyValueTooLarge'); }
    return realSave(p, k, v);
  };

  const summary = await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z')
  });

  assert.strictEqual(summary.ok, false);
  assert.deepStrictEqual(summary.sectionsFailed.map((f) => f.name), ['distributions']);
  // The other fifteen still landed — this is the regression that mattered.
  assert.strictEqual(summary.sectionsWritten.length, ALL_SECTIONS.length - 1);
  for (const name of ALL_SECTIONS.filter((n) => n !== 'distributions')) {
    assert.ok(store.saved.get(name), `${name} must still be written`);
  }
  // And distributions itself carries a named error rather than being absent.
  assert.strictEqual(store.saved.get('distributions').payload.error, 'PropertyValueTooLarge');
});

test('unparseable rows are counted and do not reduce the sections written', async () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => row(i)),
    { partitionKey: 'writing', rowKey: 'bad1', analysisJson: '{"week":"2026-W33"' },
    { partitionKey: 'writing', rowKey: 'bad2', analysisJson: 'nonsense' }
  ];
  const store = fakeStore(rows);
  const summary = await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z')
  });

  assert.strictEqual(summary.rowsScanned, 7);
  assert.strictEqual(summary.rowsAnalyzed, 5);
  assert.strictEqual(summary.rowsSkipped, 2);
  assert.strictEqual(summary.ok, true);
  assert.deepStrictEqual(summary.sectionsWritten, ALL_SECTIONS);
});

test('missing SUB_TAGS fails the cohort loudly and leaves the rest intact', async () => {
  // §9.1: an empty tag map is not a safe default — it would silently pool
  // deliberately skewed enclave subs into the population cohort. The failure
  // must be loud, and round 3's isolation must contain it to one section.
  const store = fakeStore(Array.from({ length: 5 }, (_, i) => row(i)));
  const summary = await runRollup({
    store,
    aoai: fakeAoai,
    context: silentContext,
    env: { SUBREDDITS: 'writing' }, // SUB_TAGS deliberately absent
    now: () => new Date('2026-08-15T23:30:00.000Z')
  });

  assert.strictEqual(summary.ok, false);
  assert.deepStrictEqual(summary.sectionsFailed.map((f) => f.name), ['cohort']);
  assert.match(summary.sectionsFailed[0].error, /SUB_TAGS/, 'the error must name the missing setting');
  assert.strictEqual(summary.sectionsWritten.length, ALL_SECTIONS.length - 1,
    'every other section still writes');
  assert.strictEqual(store.saved.get('cohort').payload.error.includes('SUB_TAGS'), true);
});

test('the run records a health row for /api/insights?view=health', async () => {
  const store = fakeStore([row(1)]);
  await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z')
  });
  const health = store.saved.get('rollup-health');
  assert.ok(health, 'rollup-health row must exist');
  assert.strictEqual(health.payload.ok, true);
  assert.strictEqual(health.payload.finishedAt, '2026-08-15T23:30:00.000Z');
  assert.deepStrictEqual(health.payload.sectionsFailed, []);
});

test('AOAI failure degrades the section instead of failing the run', async () => {
  const store = fakeStore(Array.from({ length: 5 }, (_, i) => row(i)));
  const brokenAoai = {
    ...fakeAoai,
    normalizeFeatures: async () => { throw new Error('AOAI 429'); },
    synthesizePersonas: async () => { throw new Error('AOAI 429'); },
    strategyBrief: async () => { throw new Error('AOAI 429'); }
  };
  const summary = await runRollup({
    store, aoai: brokenAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z')
  });

  assert.strictEqual(summary.ok, true, 'AOAI outages must not fail sections outright');
  assert.deepStrictEqual(summary.sectionsWritten, ALL_SECTIONS);
  // features degrades to raw counts; personas/brief mark themselves stale.
  assert.strictEqual(store.saved.get('features').payload.degraded, true);
  assert.strictEqual(store.saved.get('personas').payload._stale, true);
  assert.strictEqual(store.saved.get('brief').payload._stale, true);
});
