'use strict';

// CB-LISTEN-BOARDS-1 §4.1 — registry-aware ITEM-level exclusion on the boards.
//
// The defect: contentClass row-level filtering (already in place) only catches
// rows a bot/megathread AUTHORED. A row classified human that quotes verbatim
// subreddit rule text inside one deal-breaker / trust-signal / baseline entry
// still contaminates the aggregate boards, because those boards count on the
// ITEM, not the row. This is the r/BetaReaders shape: "AI-generated feedback
// and 'reviews' is also not allowed" recurring hundreds of times.

const test = require('node:test');
const assert = require('node:assert');

const { runRollup } = require('../src/lib/rollup-engine');
const contentClass = require('../src/lib/content-class');

const RULE_TEXT =
  "Please read the rules before posting. Requests for critique must include a " +
  "sample of your own work. AI-generated feedback and 'reviews' is also not allowed. " +
  "Low effort posts will be removed by the moderators without warning.";

const RULE_HASH = contentClass.hashIfEligible(RULE_TEXT);

// A genuinely different, unregistered opinion that happens to share vocabulary
// with the rule text — the over-exclusion control. Without this, a filter that
// empties the whole board would pass the same assertions as a working one.
const SIMILAR_UNREGISTERED =
  'I will personally never work with anyone who submits AI-generated feedback, ' +
  'and reviews written by a bot are worthless to me as a beta reader.';

function fakeStore(rows, registrySeed = {}) {
  const saved = new Map();
  const aggregates = new Map();
  for (const [sub, hashes] of Object.entries(registrySeed)) {
    aggregates.set(`boilerplate-registry|${sub}`, { subreddit: sub, hashes, count: Object.keys(hashes).length });
  }
  return {
    saved,
    listAnalyzedPosts: async () => rows,
    saveAggregate: async (p, k, v) => { saved.set(p, { period: k, payload: v }); aggregates.set(`${p}|${k}`, v); },
    getAggregate: async (p, k) => aggregates.get(`${p}|${k}`) || null
  };
}

const fakeAoai = {
  normalizeFeatures: async (names) => ({
    groups: names.length ? [{ canonical: names[0], members: names.map((_, i) => i) }] : []
  }),
  synthesizePersonas: async () => ({ personas: [] }),
  // Echo the evidence pack back so the test can inspect exactly what would
  // have been handed to the model — including baselineTop, which is never
  // otherwise persisted on its own.
  strategyBrief: async (evidence) => ({ answers: [], _evidence: evidence }),
  standingQuestions: () => []
};

const silentContext = { log() {}, warn() {}, error() {} };
const TEST_ENV = { SUBREDDITS: 'betareaders', SUB_TAGS: '{}', BSKY_STREAMS: '[]' };

// A human-authored row (ordinary distinct username, not stickied, not
// distinguished) whose deal-breaker/trust-signal/baseline items quote the
// registered rule text verbatim.
function contaminatedRow(i) {
  return {
    partitionKey: 'betareaders', rowKey: `dup${i}`, author: `writer_${i}`,
    title: `My draft needs a beta reader ${i}`, permalink: `/r/betareaders/comments/dup${i}/`,
    createdUtc: 1_760_000_000 + i,
    analysisJson: JSON.stringify({
      week: '2026-W33', ai_related: true, stance_on_ai: 'hostile',
      deal_breakers: [{ item: 'no ai feedback allowed', kind: 'ai-policy', quote: RULE_TEXT }],
      trust_signals: [
        { direction: 'breaks', signal: 'explicit ban on ai-generated feedback', quote: RULE_TEXT },
        { direction: 'builds', signal: 'ai disclosure required upfront', quote: RULE_TEXT }
      ],
      expected_baseline: [RULE_TEXT],
      pain_points: [],
      notable_quote: '', summary: 's'
    })
  };
}

function controlRow() {
  return {
    partitionKey: 'betareaders', rowKey: 'control1', author: 'genuine_writer',
    title: 'My honest deal-breaker', permalink: '/r/betareaders/comments/control1/',
    createdUtc: 1_760_200_000,
    analysisJson: JSON.stringify({
      week: '2026-W33', ai_related: true, stance_on_ai: 'wary',
      deal_breakers: [{ item: 'bot reviews are worthless', kind: 'ai-policy', quote: SIMILAR_UNREGISTERED }],
      trust_signals: [],
      expected_baseline: [],
      pain_points: [],
      notable_quote: '', summary: 's'
    })
  };
}

test('registry-recorded item text is excluded from every affected board; a genuine one-off survives', async () => {
  const REPEATS = 12;
  const rows = [
    ...Array.from({ length: REPEATS }, (_, i) => contaminatedRow(i)),
    controlRow()
  ];
  const store = fakeStore(rows, {
    betareaders: { [RULE_HASH]: { repeats: REPEATS + 1, kind: 'body' } }
  });

  const summary = await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV,
    now: () => new Date('2026-08-15T23:30:00.000Z')
  });
  assert.strictEqual(summary.ok, true, `sections failed: ${JSON.stringify(summary.sectionsFailed)}`);

  const minbar = store.saved.get('minbar').payload;
  const trust = store.saved.get('trust').payload;
  const brief = store.saved.get('brief').payload;

  // --- (a) absent from the top-10 of every affected board ---
  const dbTop10 = minbar.dealBreakerBoard.slice(0, 10).map((d) => d.item);
  assert.ok(!dbTop10.includes('no ai feedback allowed'), 'registry-matched deal-breaker must not reach dealBreakerBoard top-10');

  const breaksTop10 = trust.breaks.slice(0, 10).map((t) => t.signal);
  assert.ok(!breaksTop10.includes('explicit ban on ai-generated feedback'), 'registry-matched trust break must not reach trustBoard.breaks top-10');

  const buildsTop10 = trust.builds.slice(0, 10).map((t) => t.signal);
  assert.ok(!buildsTop10.includes('ai disclosure required upfront'), 'registry-matched trust build must not reach trustBoard.builds top-10');

  const baselineTopKeys = brief._evidence.baselineTop.map(([k]) => k);
  assert.ok(!baselineTopKeys.includes(RULE_TEXT.toLowerCase().trim()), 'registry-matched baseline entry must not reach baselineTop');
  assert.strictEqual(Object.keys(minbar.baselineCounts).length, 0, 'the only baseline entry contributed was registry text');

  // --- (b) excluded.count >= the seeded repeat count ---
  assert.ok(minbar.excluded.count >= REPEATS, `minbar.excluded.count (${minbar.excluded.count}) should be >= ${REPEATS}`);
  assert.ok(trust.excluded.count >= REPEATS * 2, `trust.excluded.count (${trust.excluded.count}) should be >= ${REPEATS * 2} (breaks + builds)`);
  assert.ok(minbar.excluded.byReason.registry >= REPEATS);
  assert.ok(brief.excluded.count > 0, 'the evidence pack must report its own exclusions');

  // --- (c) the over-exclusion control: a genuine one-off with similar-but-
  // unregistered text must survive untouched. ---
  assert.ok(minbar.dealBreakerBoard.some((d) => d.item === 'bot reviews are worthless'),
    'a genuine unregistered deal-breaker must not be swept up by the filter');
});

test('with no registry seeded, the same corpus leaks the rule text (proves the registry rung specifically can fail)', async () => {
  // CB-LISTEN-BOARDS-2 §3 S1 note: this is now a two-mechanism filter, and S1
  // (quote recurrence) is deliberately independent of the registry — a quote
  // repeated across enough distinct permalinks is excluded with NO registry
  // entry at all (see rollup-quote-recurrence.test.js). To isolate "the
  // registry rung specifically can fail" from S1 picking up the slack, this
  // stays BELOW the quote-recurrence threshold (minQuoteRepeats, default 5):
  // 3 distinct permalinks share the quote, not enough for either mechanism.
  const rows = Array.from({ length: 3 }, (_, i) => contaminatedRow(i));
  const store = fakeStore(rows, {}); // no registry entries at all

  await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV,
    now: () => new Date('2026-08-15T23:30:00.000Z')
  });

  const minbar = store.saved.get('minbar').payload;
  assert.ok(minbar.dealBreakerBoard.some((d) => d.item === 'no ai feedback allowed'),
    'without a seeded registry and below the S1 recurrence threshold, the unfiltered item must appear — or this suite is vacuous');
  assert.strictEqual(minbar.excluded.byReason.registry, 0);
  assert.strictEqual(minbar.excluded.byReason['quote-recurrence'], 0);
});
