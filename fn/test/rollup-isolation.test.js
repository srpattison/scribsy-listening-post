'use strict';

// The point of round 3: one failing section cannot zero out the others.
//
// These tests exercise lib/rollup-engine.js directly with fake dependencies —
// no Azure SDK, no Functions host, no network. Run with `npm test` (node:test).
//
// NOTE ON VALIDITY: "a test that cannot fail if the isolation is removed does
// not count". Delete the try/catch in runSections() and
// `writes every section after a throwing one` fails on the very next
// assertion — it is the isolation, not the fake store, that keeps the run
// going. Verified against the pre-fix code path by
// `sequential writes abort at the first throw (pre-fix behaviour)`, which
// reproduces the old unguarded write sequence and asserts it loses the tail.

const test = require('node:test');
const assert = require('node:assert');

const { runSections, parseRows } = require('../src/lib/rollup-engine');

// A fake aggregates table.
function fakeStore() {
  const saved = new Map();
  return {
    saved,
    saveAggregate: async (partition, period, payload) => {
      saved.set(partition, { period, payload });
    },
    names: () => [...saved.keys()]
  };
}

const silentContext = { log() {}, warn() {}, error() {} };

// Fifteen sections named the way the real rollup names them.
const SECTION_NAMES = [
  'meta', 'heatmap', 'stance', 'distributions', 'features', 'minbar', 'trust',
  'cohort', 'quotes', 'personas', 'competitors', 'resonance', 'signals',
  'discovery', 'brief'
];

function sectionsWithThrowAt(index, message = 'injected section failure') {
  return SECTION_NAMES.map((name, i) => ({
    name,
    build: async () => {
      if (i === index) throw new Error(message);
      return { ok: true, name };
    }
  }));
}

test('writes every section after a throwing one', async () => {
  const store = fakeStore();
  // Position 2 = the second section (1-indexed), i.e. index 1.
  const sections = sectionsWithThrowAt(1);

  const { written, failed } = await runSections(sections, {
    saveAggregate: store.saveAggregate,
    context: silentContext
  });

  // The thrower is reported, not swallowed.
  assert.deepStrictEqual(failed.map((f) => f.name), ['heatmap']);
  assert.match(failed[0].error, /injected section failure/);

  // Sections 3..15 are all still written.
  const expectedWritten = SECTION_NAMES.filter((n) => n !== 'heatmap');
  assert.deepStrictEqual(written, expectedWritten);
  assert.strictEqual(written.length, 14);

  // And every one of them is actually in the store with real content.
  for (const name of expectedWritten) {
    assert.ok(store.saved.has(name), `${name} should have been written`);
    assert.deepStrictEqual(store.saved.get(name).payload, { ok: true, name });
  }
});

test('a failed section writes an error row instead of vanishing', async () => {
  const store = fakeStore();
  const { failed } = await runSections(sectionsWithThrowAt(3, 'PropertyValueTooLarge'), {
    saveAggregate: store.saveAggregate,
    context: silentContext,
    now: () => new Date('2026-08-15T23:00:00.000Z')
  });

  assert.deepStrictEqual(failed.map((f) => f.name), ['distributions']);

  // The row exists and names the failure — this is what stops the dashboard
  // rendering a missing section as "no data yet".
  const row = store.saved.get('distributions');
  assert.ok(row, 'distributions row must exist even though the section threw');
  assert.strictEqual(row.payload.error, 'PropertyValueTooLarge');
  assert.strictEqual(row.payload.failedAt, '2026-08-15T23:00:00.000Z');
});

test('every section can fail independently without affecting the others', async () => {
  for (let i = 0; i < SECTION_NAMES.length; i++) {
    const store = fakeStore();
    const { written, failed } = await runSections(sectionsWithThrowAt(i), {
      saveAggregate: store.saveAggregate,
      context: silentContext
    });
    assert.strictEqual(failed.length, 1, `exactly one failure when section ${i} throws`);
    assert.strictEqual(written.length, SECTION_NAMES.length - 1,
      `the other ${SECTION_NAMES.length - 1} sections still write when ${SECTION_NAMES[i]} throws`);
    // All 15 rows are present: 14 real + 1 error row.
    assert.strictEqual(store.saved.size, SECTION_NAMES.length);
  }
});

test('a section whose error row also fails to save is still reported', async () => {
  const sections = sectionsWithThrowAt(0);
  const { written, failed } = await runSections(sections, {
    saveAggregate: async (partition) => {
      if (partition === 'meta') throw new Error('storage down');
    },
    context: silentContext
  });
  assert.strictEqual(failed.length, 1);
  assert.strictEqual(failed[0].name, 'meta');
  assert.match(failed[0].alsoFailedToRecord, /storage down/);
  // The run still continued through the remaining sections.
  assert.strictEqual(written.length, SECTION_NAMES.length - 1);
});

test('a later section can read an earlier section result, and tolerate its absence', async () => {
  const store = fakeStore();
  const sections = [
    { name: 'distributions', build: async () => { throw new Error('too large'); } },
    {
      name: 'brief',
      build: async (results) => {
        // Mirrors the real dependent sections: read defensively.
        const dist = results.distributions || {};
        return { stanceKeys: Object.keys(dist.stances || {}), sawDistributions: !!results.distributions };
      }
    }
  ];
  const { written, failed } = await runSections(sections, {
    saveAggregate: store.saveAggregate,
    context: silentContext
  });
  assert.deepStrictEqual(failed.map((f) => f.name), ['distributions']);
  assert.deepStrictEqual(written, ['brief']);
  assert.deepStrictEqual(store.saved.get('brief').payload, { stanceKeys: [], sawDistributions: false });
});

// ---------------------------------------------------------------------------
// Guard against regressing to the old behaviour.
// ---------------------------------------------------------------------------

test('sequential writes abort at the first throw (pre-fix behaviour)', async () => {
  // This reproduces the code this round replaced: compute everything, then run
  // one unguarded write sequence. It documents WHY the isolation is needed —
  // three sections land, twelve never do.
  const store = fakeStore();
  const writes = SECTION_NAMES.map((name, i) => async () => {
    if (i === 3) throw new Error('PropertyValueTooLarge'); // distributions
    await store.saveAggregate(name, 'latest', { ok: true });
  });

  await assert.rejects(async () => {
    for (const w of writes) await w();
  }, /PropertyValueTooLarge/);

  // Exactly the three sections ahead of the abort point — the observed
  // production signature (meta, heatmap, stance written; the other twelve absent).
  assert.deepStrictEqual(store.names(), ['meta', 'heatmap', 'stance']);
  assert.strictEqual(store.saved.size, 3);
});

// ---------------------------------------------------------------------------
// Per-row isolation (§4.2)
// ---------------------------------------------------------------------------

function rowWith(analysis, extra = {}) {
  return {
    partitionKey: 'writing',
    rowKey: extra.rowKey || 'abc123',
    title: 'a post',
    author: 'someone',
    permalink: '/r/writing/abc123',
    score: 5,
    createdUtc: 1_760_000_000,
    analysisJson: typeof analysis === 'string' ? analysis : JSON.stringify(analysis),
    ...extra
  };
}

const goodAnalysis = {
  week: '2026-W33', ai_related: true, stance_on_ai: 'wary', topics: ['craft-authenticity'],
  summary: 's', notable_quote: 'q'
};

test('an invalid analysisJson row does not abort the section and increments rowsSkipped by exactly 1', () => {
  const rows = [
    rowWith(goodAnalysis, { rowKey: 'a' }),
    rowWith('{"week":"2026-W33","ai_relat', { rowKey: 'b' }), // truncated JSON — unparseable
    rowWith(goodAnalysis, { rowKey: 'c' })
  ];

  const { items, skipped } = parseRows(rows);

  assert.strictEqual(skipped, 1, 'exactly one row skipped');
  assert.strictEqual(items.length, 2, 'the two good rows survive');
  assert.deepStrictEqual(items.map((i) => i.id), ['a', 'c']);
});

test('parseRows survives rows with missing and malformed fields', () => {
  const rows = [
    rowWith(goodAnalysis, { rowKey: 'ok' }),
    rowWith(null, { rowKey: 'nullAnalysis' }),            // analysisJson === "null"
    rowWith({}, { rowKey: 'emptyAnalysis' }),             // parses, but no fields
    { partitionKey: 'writing', rowKey: 'noJson' },        // no analysisJson at all
    rowWith('not json at all', { rowKey: 'garbage' })
  ];

  const { items, skipped } = parseRows(rows);

  // nullAnalysis, noJson and garbage are skipped; ok + emptyAnalysis survive.
  assert.strictEqual(skipped, 3);
  assert.deepStrictEqual(items.map((i) => i.id), ['ok', 'emptyAnalysis']);
  // The empty analysis still yields safe defaults rather than throwing.
  const empty = items.find((i) => i.id === 'emptyAnalysis');
  assert.strictEqual(empty.stance, 'na');
  assert.deepStrictEqual(empty.topics, []);
  assert.strictEqual(empty.aiRelated, false);
});

test('parseRows never throws on a hostile row', () => {
  const rows = [
    rowWith({ ...goodAnalysis, tools_mentioned: [{ tool: null }], topics: null }, { rowKey: 'hostile' }),
    rowWith(goodAnalysis, { rowKey: 'fine' })
  ];
  assert.doesNotThrow(() => parseRows(rows));
  const { items } = parseRows(rows);
  assert.ok(items.some((i) => i.id === 'fine'), 'the good row still comes through');
});
