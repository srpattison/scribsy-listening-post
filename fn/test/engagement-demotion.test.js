'use strict';

// §3c — score / numComments must not weight, rank, sort or threshold anything.
//
// Arctic Shift captures a near-creation snapshot and never backfills, and its
// capture lag varies per row: 35% of sampled rows sit at score 1, 32% at 0
// comments. A uniform freeze would be obviously useless; a partial freeze with
// unknown per-row lag looks like genuine variance, which is worse. Ranking on
// it ranks by how late the archiver happened to look.
//
// VALIDITY (§4): the grep assertion below is verified to FAIL against the
// pre-fix source — see fn/test/fixtures/pre-round4-rollup-engine.txt, an
// extract of the c939407 ranking code, which the last test in this file feeds
// through the same scanner and asserts is rejected. A grep that cannot fail
// does not count.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const engine = require('../src/lib/rollup-engine');

const SRC_DIR = path.join(__dirname, '..', 'src');

// Code paths that produce or order aggregates. Adapters are excluded: they must
// still READ the raw field off the wire in order to store it.
const AGGREGATE_PATHS = [
  'lib/rollup-engine.js',
  'functions/api.js',
  'functions/rollup.js'
];

// Strip comments and strings so prose about `score` cannot trip the scan, and
// neither can the renamed identifiers.
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

// §3c.2 keeps the columns as stored metadata and renames them ON READ, so each
// read path needs exactly one site that touches the raw column in order to
// relabel it: `scoreAtCapture: r.score`. That single site is permitted; the
// count is asserted separately so it cannot become a loophole.
const RENAME_SITE = /\b(?:scoreAtCapture|numCommentsAtCapture)\s*:\s*\w+\.(?:score|numComments)\b(?:\s*\|\|\s*0)?/g;

// A reference to raw engagement is any `score` / `numComments` identifier that
// is neither a capture-labelled name nor part of the rename site.
function engagementRefs(src) {
  const code = codeOnly(src).replace(RENAME_SITE, 'RENAME_SITE');
  const hits = [];
  for (const m of code.matchAll(/\b(scoreAtCapture|numCommentsAtCapture|score|numComments|num_comments)\b/g)) {
    if (m[1] === 'scoreAtCapture' || m[1] === 'numCommentsAtCapture') continue;
    const line = code.slice(0, m.index).split('\n').length;
    hits.push({ name: m[1], line });
  }
  return hits;
}

const renameSiteCount = (src) => (codeOnly(src).match(RENAME_SITE) || []).length;

for (const rel of AGGREGATE_PATHS) {
  test(`${rel} does not rank on frozen engagement`, () => {
    const src = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
    const hits = engagementRefs(src);
    assert.deepStrictEqual(
      hits, [],
      `${rel} references raw engagement at line(s) ${hits.map((h) => `${h.line}:${h.name}`).join(', ')}`
    );
  });

  test(`${rel} touches the raw columns only to rename them`, () => {
    const src = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
    assert.ok(renameSiteCount(src) <= 2,
      `${rel} has ${renameSiteCount(src)} rename sites; at most one per column is legitimate`);
  });
}

test('the scanner rejects the pre-fix ranking code (proves it can fail)', () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'pre-round4-rollup-engine.txt'), 'utf8');
  const hits = engagementRefs(fixture);
  assert.ok(hits.length >= 4,
    `expected the pre-fix extract to trip the scanner, got ${hits.length} hits`);
  assert.ok(hits.some((h) => h.name === 'score'), 'pre-fix code ranked on score');
});

// ---------------------------------------------------------------------------
// Behaviour, not just grep: ordering must ignore engagement entirely.
// ---------------------------------------------------------------------------

const rowFor = (over) => ({
  id: over.id,
  createdUtc: over.createdUtc ?? 1000,
  scoreAtCapture: over.scoreAtCapture ?? 0,
  topics: over.topics || [],
  painPoints: over.painPoints || [],
  threadId: over.threadId || over.id
});

test('salience counts distinct threads, not repeats within one thread', () => {
  const rows = [
    rowFor({ id: 'a', threadId: 't1', topics: ['x'] }),
    rowFor({ id: 'b', threadId: 't1', topics: ['x'] }), // same thread — must not double-count
    rowFor({ id: 'c', threadId: 't2', topics: ['x'] }),
    rowFor({ id: 'd', threadId: 't3', topics: ['y'] })
  ];
  const index = engine.buildRecurrenceIndex(rows);
  assert.strictEqual(index.topics.x, 2, 'topic x appears in 2 distinct threads');
  assert.strictEqual(index.topics.y, 1);
});

test('a widely-recurring claim outranks a high-score one-off', () => {
  const rows = [
    // One popular post; its topic appears nowhere else.
    rowFor({ id: 'viral', threadId: 'tv', topics: ['rare'], scoreAtCapture: 99999 }),
    // A concern raised across three independent threads, all at score 1.
    rowFor({ id: 'r1', threadId: 't1', topics: ['common'], scoreAtCapture: 1 }),
    rowFor({ id: 'r2', threadId: 't2', topics: ['common'], scoreAtCapture: 1 }),
    rowFor({ id: 'r3', threadId: 't3', topics: ['common'], scoreAtCapture: 1 })
  ];
  const index = engine.buildRecurrenceIndex(rows);
  const ordered = rows.slice().sort(engine.bySalience(index));
  assert.notStrictEqual(ordered[0].id, 'viral',
    'the single high-score row must not win on engagement');
  assert.ok(['r1', 'r2', 'r3'].includes(ordered[0].id));
});

test('ordering is unchanged when every engagement number is rewritten', () => {
  const base = [
    rowFor({ id: 'a', threadId: 't1', topics: ['x'], createdUtc: 10 }),
    rowFor({ id: 'b', threadId: 't2', topics: ['x', 'y'], createdUtc: 20 }),
    rowFor({ id: 'c', threadId: 't3', topics: ['y'], createdUtc: 30 })
  ];
  const index = engine.buildRecurrenceIndex(base);
  const before = base.slice().sort(engine.bySalience(index)).map((r) => r.id);

  // Invert the engagement numbers entirely. Nothing may move.
  const scrambled = base.map((r, i) => ({ ...r, scoreAtCapture: (3 - i) * 1000, numCommentsAtCapture: i * 77 }));
  const after = scrambled.sort(engine.bySalience(index)).map((r) => r.id);

  assert.deepStrictEqual(after, before, 'engagement must not influence ordering at all');
});

test('ordering is deterministic across runs for equal salience', () => {
  const rows = [
    rowFor({ id: 'b', threadId: 't2', topics: ['x'], createdUtc: 50 }),
    rowFor({ id: 'a', threadId: 't1', topics: ['x'], createdUtc: 50 })
  ];
  const index = engine.buildRecurrenceIndex(rows);
  const once = rows.slice().sort(engine.bySalience(index)).map((r) => r.id);
  const twice = rows.slice().reverse().sort(engine.bySalience(index)).map((r) => r.id);
  assert.deepStrictEqual(once, twice, 'equal-salience rows must not reshuffle between runs');
});

test('parseRows renames engagement to capture-labelled fields', () => {
  const { items } = engine.parseRows([{
    partitionKey: 'writing', rowKey: 'x1', score: 42, numComments: 7,
    analysisJson: JSON.stringify({ ai_related: true, stance_on_ai: 'wary' })
  }]);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].scoreAtCapture, 42);
  assert.strictEqual(items[0].numCommentsAtCapture, 7);
  assert.strictEqual(items[0].score, undefined, 'the unqualified name must not survive the read');
  assert.strictEqual(items[0].numComments, undefined);
});
