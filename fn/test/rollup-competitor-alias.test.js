'use strict';

// CB-LISTEN-BOARDS-1 §4.3 — competitor name normalisation.
//
// tools_mentioned[].tool is free text from the LLM with no canonicalisation
// pass (unlike feature_requests). "archive of our own", "Archive of Our Own"
// and "AO3" are today three distinct board rows for the same tool.

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

function row(i, tool) {
  return {
    partitionKey: 'writing', rowKey: 'id' + i, author: 'author' + i,
    permalink: '/r/writing/id' + i, createdUtc: 1_760_000_000,
    analysisJson: JSON.stringify({
      week: '2026-W33', ai_related: true, stance_on_ai: 'curious',
      tools_mentioned: [{ tool, sentiment: 'neutral', switching: false, context: 'c' }],
      notable_quote: '', summary: 's'
    })
  };
}

test('both AO3 spellings collapse into one board row with the summed mention count', async () => {
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => row(i, 'archive of our own')),
    ...Array.from({ length: 2 }, (_, i) => row(10 + i, 'AO3')),
    row(20, 'Scrivener') // control: a genuinely different tool
  ];
  const store = fakeStore(rows);
  await runRollup({ store, aoai: fakeAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z') });

  const board = store.saved.get('competitors').payload.board;
  const ao3 = board.find((t) => t.tool === 'AO3');
  assert.ok(ao3, 'a canonical AO3 row must exist');
  assert.strictEqual(ao3.mentions, 5, 'mentions must equal the sum of both spellings');
  assert.strictEqual(ao3.variants.length, 2, 'variants must list exactly the two raw spellings collapsed into it');
  assert.deepStrictEqual([...ao3.variants].sort(), ['AO3', 'archive of our own']);

  // Control: two genuinely different tools are never merged.
  const scrivener = board.find((t) => t.tool === 'Scrivener');
  assert.ok(scrivener, 'an unrelated tool must survive under its own name');
  assert.strictEqual(scrivener.mentions, 1);
  assert.strictEqual(board.filter((t) => t.tool === 'AO3' || t.tool === 'Scrivener').length, 2,
    'AO3 and Scrivener must not have been merged with each other');
});

test('a trailing parenthetical is stripped before alias lookup', async () => {
  const rows = [row(1, 'Archive of Our Own (AO3)'), row(2, 'ao3')];
  const store = fakeStore(rows);
  await runRollup({ store, aoai: fakeAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z') });
  const board = store.saved.get('competitors').payload.board;
  assert.strictEqual(board.length, 1);
  assert.strictEqual(board[0].tool, 'AO3');
  assert.strictEqual(board[0].mentions, 2);
});

test('an unmapped tool name is never dropped — falls back to the trimmed original', async () => {
  const rows = [row(1, '  NovelCrafter  ')];
  const store = fakeStore(rows);
  await runRollup({ store, aoai: fakeAoai, context: silentContext, env: TEST_ENV, now: () => new Date('2026-08-15T23:30:00.000Z') });
  const board = store.saved.get('competitors').payload.board;
  assert.strictEqual(board.length, 1);
  assert.strictEqual(board[0].tool, 'NovelCrafter');
});
