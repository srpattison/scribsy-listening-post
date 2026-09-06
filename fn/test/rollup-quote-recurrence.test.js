'use strict';

// CB-LISTEN-BOARDS-2 §3 S1 — item-level exclusion by QUOTE recurrence.
//
// The defect BOARDS-1 left open: the registry indexes whole bodies/titles,
// but the analyzer emits a sentence-level QUOTE extracted from a body —
// hash(sentence) != hash(body) at any floor, so a recurring quote never
// matches the registry no matter how it is tuned. This suite proves the
// SEPARATE quote-recurrence rung catches that population, without touching
// the registry, and — the over-exclusion guard the whole round exists to
// enforce (brief §5 A5) — that recurrence never fires on a LABEL, only on a
// genuine verbatim quote.

const test = require('node:test');
const assert = require('node:assert');

const { runRollup } = require('../src/lib/rollup-engine');

const RECURRING_QUOTE = 'AI-generated feedback and reviews is also not allowed here at all.';
// Markdown-bold + smart-quote decorated copies of the exact same sentence
// (CB-LISTEN-BOARDS-2 §2 item 4) — S4 normalisation must collapse these to
// the same hash as RECURRING_QUOTE before S1 ever sees them.
const RECURRING_QUOTE_BOLD = `**${RECURRING_QUOTE}**`;
const RECURRING_QUOTE_SMART = 'AI-generated feedback and “reviews” is also not allowed here at all.';

const GENUINE_QUOTE = 'I will never trust a tool that trains on my manuscript without asking first.';

function fakeStore(rows) {
  const saved = new Map();
  return {
    saved,
    listAnalyzedPosts: async () => rows,
    saveAggregate: async (p, k, v) => saved.set(p, { period: k, payload: v }),
    // No registry seeded anywhere — proves this rung needs no registry entry.
    getAggregate: async () => null
  };
}

const fakeAoai = {
  normalizeFeatures: async (names) => ({
    groups: names.length ? [{ canonical: names[0], members: names.map((_, i) => i) }] : []
  }),
  synthesizePersonas: async () => ({ personas: [] }),
  strategyBrief: async (evidence) => ({ answers: [], _evidence: evidence }),
  standingQuestions: () => []
};

const silentContext = { log() {}, warn() {}, error() {} };
const TEST_ENV = { SUBREDDITS: 'betareaders', SUB_TAGS: '{}', BSKY_STREAMS: '[]' };

function rowWithDealBreaker(i, quote, item = 'no ai feedback allowed') {
  return {
    partitionKey: 'betareaders', rowKey: `q${i}`, author: `writer_${i}`,
    title: `My draft ${i}`, permalink: `/r/betareaders/comments/q${i}/`,
    createdUtc: 1_760_000_000 + i,
    analysisJson: JSON.stringify({
      week: '2026-W33', ai_related: true, stance_on_ai: 'hostile',
      deal_breakers: [{ item, kind: 'ai-policy', quote }],
      trust_signals: [], expected_baseline: [], pain_points: [],
      notable_quote: '', summary: 's'
    })
  };
}

test('S1: a quote recurring verbatim across many distinct permalinks is excluded with no registry entry', async () => {
  const REPEATS = 8;
  const rows = [
    ...Array.from({ length: REPEATS }, (_, i) => rowWithDealBreaker(i, RECURRING_QUOTE)),
    rowWithDealBreaker('control', GENUINE_QUOTE, 'trains on my writing without consent')
  ];
  const store = fakeStore(rows);

  const summary = await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV,
    now: () => new Date('2026-08-15T23:30:00.000Z')
  });
  assert.strictEqual(summary.ok, true, `sections failed: ${JSON.stringify(summary.sectionsFailed)}`);

  const minbar = store.saved.get('minbar').payload;
  const dbTop = minbar.dealBreakerBoard.map((d) => d.item);
  assert.ok(!dbTop.includes('no ai feedback allowed'),
    'a quote recurring across 8 distinct permalinks must not reach the board, with no registry involved');
  assert.ok(minbar.excluded.byReason['quote-recurrence'] >= REPEATS,
    `expected byReason['quote-recurrence'] >= ${REPEATS}, got ${JSON.stringify(minbar.excluded.byReason)}`);

  // Over-exclusion control (brief §5 A5): a genuine one-off quote survives.
  assert.ok(dbTop.includes('trains on my writing without consent'),
    'a genuine unregistered, non-recurring deal-breaker must survive');
});

test('S1: markdown-bold and smart-quote variants of the same sentence collapse to one recurring hash (S4)', async () => {
  const variants = [RECURRING_QUOTE, RECURRING_QUOTE_BOLD, RECURRING_QUOTE_SMART, RECURRING_QUOTE, RECURRING_QUOTE_BOLD, RECURRING_QUOTE_SMART];
  const rows = variants.map((q, i) => rowWithDealBreaker(i, q));
  const store = fakeStore(rows);

  const summary = await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV,
    now: () => new Date('2026-08-15T23:30:00.000Z')
  });
  assert.strictEqual(summary.ok, true);

  const minbar = store.saved.get('minbar').payload;
  assert.ok(!minbar.dealBreakerBoard.some((d) => d.item === 'no ai feedback allowed'),
    'markdown/smart-quote variants of one sentence must collapse to a single recurring hash and be excluded together');
  assert.strictEqual(minbar.excluded.byReason['quote-recurrence'], variants.length,
    'every variant must count toward the same recurrence bucket, not six separate hashes');
});

test('S1 never applies to LABELS: many genuinely distinct quotes sharing one label all survive', async () => {
  // The brief's own worked example: "content warnings" as a label shared by
  // many legitimately distinct posts must not be treated as 363 repeats of
  // one string. Simulated here at smaller scale with distinct verbatim quotes.
  const rows = Array.from({ length: 8 }, (_, i) => rowWithDealBreaker(
    i,
    `I personally will not work with a tool that mishandles content warning number ${i} in my manuscript.`,
    'content warnings'
  ));
  const store = fakeStore(rows);

  const summary = await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV,
    now: () => new Date('2026-08-15T23:30:00.000Z')
  });
  assert.strictEqual(summary.ok, true);

  const minbar = store.saved.get('minbar').payload;
  const entry = minbar.dealBreakerBoard.find((d) => d.item === 'content warnings');
  assert.ok(entry, '"content warnings" must still reach the board');
  assert.strictEqual(entry.count, 8, 'all 8 legitimately distinct posts must be counted, none excluded by label recurrence');
  assert.strictEqual(minbar.excluded.byReason['quote-recurrence'], 0,
    'distinct quotes under a shared label must never trip quote-recurrence');
});

test('S1 does not reach pain_points or expected_baseline (no separate quote field — out of scope, brief §4)', async () => {
  const REPEAT_PHRASE = 'no beta readers available in my genre right now';
  const rows = Array.from({ length: 8 }, (_, i) => ({
    partitionKey: 'betareaders', rowKey: `p${i}`, author: `writer_${i}`,
    title: `post ${i}`, permalink: `/r/betareaders/comments/p${i}/`,
    createdUtc: 1_760_000_000 + i,
    analysisJson: JSON.stringify({
      week: '2026-W33', ai_related: true, stance_on_ai: 'wary',
      deal_breakers: [], trust_signals: [],
      expected_baseline: [REPEAT_PHRASE],
      pain_points: [REPEAT_PHRASE],
      notable_quote: '', summary: 's'
    })
  }));
  const store = fakeStore(rows);

  const summary = await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV,
    now: () => new Date('2026-08-15T23:30:00.000Z')
  });
  assert.strictEqual(summary.ok, true);

  const minbar = store.saved.get('minbar').payload;
  const distributions = store.saved.get('distributions').payload;
  assert.strictEqual(minbar.baselineCounts[REPEAT_PHRASE], 8,
    'genuinely shared baseline sentiment (no quote field to check) must not be excluded by S1');
  assert.strictEqual(distributions.painCounts[REPEAT_PHRASE], 8,
    'genuinely shared pain-point sentiment (no quote field to check) must not be excluded by S1');
});

test('with an unregistered, non-recurring quote, the same shape leaks through unfiltered (proves S1 can fail)', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => rowWithDealBreaker(i, RECURRING_QUOTE));
  const store = fakeStore(rows);

  await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV,
    now: () => new Date('2026-08-15T23:30:00.000Z')
  });

  const minbar = store.saved.get('minbar').payload;
  assert.ok(minbar.dealBreakerBoard.some((d) => d.item === 'no ai feedback allowed'),
    'below the recurrence threshold, the item must appear — or this suite is vacuous');
  assert.strictEqual(minbar.excluded.byReason['quote-recurrence'], 0);
});
