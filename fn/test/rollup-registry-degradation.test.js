'use strict';

// CB-LISTEN-BOARDS-2 §3 S3 — surface the silent registry-load degradation.
//
// rollup-engine.js wraps the registry load in try/catch and falls back to
// makeExcluder(new Map()) — the registry rung of the item filter disabled for
// the whole run, context.warn only, runRollup still returns ok, and (per the
// brief) no test covered the branch because the fake store used elsewhere in
// this suite cannot throw. This file's fake store CAN throw, on demand, for
// exactly the boilerplate-registry partition, so the branch is finally red-
// first-provable and then green.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { runRollup } = require('../src/lib/rollup-engine');

const fakeAoai = {
  normalizeFeatures: async () => ({ groups: [] }),
  synthesizePersonas: async () => ({ personas: [] }),
  strategyBrief: async (evidence) => ({ answers: [], _evidence: evidence }),
  standingQuestions: () => []
};

const silentContext = { log() {}, warn() {}, error() {} };
const TEST_ENV = { SUBREDDITS: 'betareaders', SUB_TAGS: '{}', BSKY_STREAMS: '[]' };

const RECURRING_QUOTE = 'this community has a strict zero-tolerance policy on any AI assistance whatsoever.';

function rowWithDealBreaker(i) {
  return {
    partitionKey: 'betareaders', rowKey: `r${i}`, author: `writer_${i}`,
    title: `post ${i}`, permalink: `/r/betareaders/comments/r${i}/`,
    createdUtc: 1_760_000_000 + i,
    analysisJson: JSON.stringify({
      week: '2026-W33', ai_related: true, stance_on_ai: 'hostile',
      deal_breakers: [{ item: 'zero tolerance policy', kind: 'ai-policy', quote: RECURRING_QUOTE }],
      trust_signals: [], expected_baseline: [], pain_points: [],
      notable_quote: '', summary: 's'
    })
  };
}

// Throws on every getAggregate call against the boilerplate-registry
// partition — the exact call loadRegistryForSubs makes — while behaving
// normally for every other partition, so the rest of the rollup runs intact.
function throwingRegistryStore(rows) {
  const saved = new Map();
  return {
    saved,
    listAnalyzedPosts: async () => rows,
    saveAggregate: async (p, k, v) => saved.set(p, { period: k, payload: v }),
    getAggregate: async (partition) => {
      if (partition === 'boilerplate-registry') {
        throw new Error('simulated Table Storage outage reading boilerplate-registry');
      }
      return null;
    }
  };
}

test('a forced registry-load throw is health-visible, not just warn-logged', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => rowWithDealBreaker(i));
  const store = throwingRegistryStore(rows);

  const summary = await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV,
    now: () => new Date('2026-08-15T23:30:00.000Z')
  });

  // The run itself must not fail — a registry outage degrades one rung of one
  // filter, it must not take down the rollup (round-3 contract).
  assert.strictEqual(summary.ok, true, `sections failed: ${JSON.stringify(summary.sectionsFailed)}`);
  assert.ok(summary.boilerplateRegistryHealth, 'summary must carry a boilerplateRegistryHealth block');
  assert.strictEqual(summary.boilerplateRegistryHealth.degraded, true);
  assert.match(summary.boilerplateRegistryHealth.error, /simulated Table Storage outage/);

  // The registry rung was down for this run, so nothing is excluded BY
  // REGISTRY — but S1 quote-recurrence is independent of the registry and
  // must still have caught the recurring quote (defense in depth).
  const minbar = store.saved.get('minbar').payload;
  assert.strictEqual(minbar.excluded.byReason.registry, 0,
    'the registry rung was down; it must report zero, not silently succeed');
  assert.ok(minbar.excluded.byReason['quote-recurrence'] >= 8,
    'quote-recurrence must still fire independently of the registry outage');
});

test('with the registry healthy, the same run reports degraded: false (proves the signal can be negative too)', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => rowWithDealBreaker(i));
  const store = {
    saved: new Map(),
    listAnalyzedPosts: async () => rows,
    saveAggregate: async function (p, k, v) { this.saved.set(p, { period: k, payload: v }); },
    getAggregate: async () => null
  };

  const summary = await runRollup({
    store, aoai: fakeAoai, context: silentContext, env: TEST_ENV,
    now: () => new Date('2026-08-15T23:30:00.000Z')
  });

  assert.strictEqual(summary.boilerplateRegistryHealth.degraded, false);
  assert.strictEqual(summary.boilerplateRegistryHealth.error, null);
});

// api.js cannot be `require`d in this test environment (@azure/functions is
// not installed — see fn/test/api-views.test.js's header note), so the
// reader-side wiring is verified by source inspection, the same technique
// api-views.test.js uses for VIEWS.
test('api.js health() reads boilerplateRegistryHealth from the rollup aggregate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'functions', 'api.js'), 'utf8');
  assert.match(src, /boilerplateRegistryHealth:\s*\(rollup && rollup\.boilerplateRegistryHealth\)/,
    'health() must pass the rollup summary\'s boilerplateRegistryHealth through, not drop it');
});
