'use strict';

// CB-LISTEN-BOARDS-1 §4.4 — topic tags: de-duplicate per row, lock the
// existing ai_related scoping.
//
// Per C4, heatmap already scopes to humanAiRows (do not change that). The
// remaining defect is that r.topics is never de-duplicated per row before
// counting, in both the heat and heatBySub loops and in distributions'
// topicTotals (bounded audit, §4.4(c)).

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

const fakeAoai = {
  normalizeFeatures: async () => ({ groups: [] }),
  synthesizePersonas: async () => ({ personas: [] }),
  strategyBrief: async () => ({ answers: [] }),
  standingQuestions: () => []
};
const silentContext = { log() {}, warn() {}, error() {} };
const TEST_ENV = { SUBREDDITS: 'writing', SUB_TAGS: '{}', BSKY_STREAMS: '[]' };

function row(i, { topics, aiRelated = true }) {
  return {
    partitionKey: 'writing', rowKey: 'id' + i, author: 'author' + i,
    permalink: '/r/writing/id' + i, createdUtc: 1_760_000_000,
    analysisJson: JSON.stringify({
      week: '2026-W33', ai_related: aiRelated, stance_on_ai: 'curious',
      topics, notable_quote: '', summary: 's'
    })
  };
}

test('a row with a repeated topic slug contributes 1, not 2, to heat and heatBySub', async () => {
  const rows = [row(1, { topics: ['craft-authenticity', 'craft-authenticity', 'craft-skill-atrophy'] })];
  const store = fakeStore(rows);
  await runRollup({ store, aoai: fakeAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z') });

  const hm = store.saved.get('heatmap').payload;
  assert.strictEqual(hm.heat['craft-authenticity']['2026-W33'], 1, 'heat must count the row once for the duplicated slug');
  assert.strictEqual(hm.heatBySub.writing['craft-authenticity'], 1, 'heatBySub must count the row once for the duplicated slug');
  assert.strictEqual(hm.heat['craft-skill-atrophy']['2026-W33'], 1);
});

test('locking test: a row with ai_related=false contributes zero to heat and heatBySub (must already pass on main)', async () => {
  const rows = [row(1, { topics: ['craft-authenticity'], aiRelated: false })];
  const store = fakeStore(rows);
  await runRollup({ store, aoai: fakeAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z') });

  const hm = store.saved.get('heatmap').payload;
  assert.strictEqual((hm.heat['craft-authenticity'] || {})['2026-W33'] || 0, 0,
    'a non-ai_related row must never contribute to the topic heat map');
  assert.strictEqual((hm.heatBySub.writing || {})['craft-authenticity'] || 0, 0);
});

test('distributions.topicTotals also de-duplicates per row (bounded-audit fix, §4.4c)', async () => {
  const rows = [row(1, { topics: ['craft-authenticity', 'craft-authenticity'] })];
  const store = fakeStore(rows);
  await runRollup({ store, aoai: fakeAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z') });
  const dist = store.saved.get('distributions').payload;
  assert.strictEqual(dist.topicTotals['craft-authenticity'], 1);
});
