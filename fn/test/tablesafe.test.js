'use strict';

// Size guards for Azure Table Storage (§4.3).
//
// The bug this round fixes: `JSON.stringify(payload).slice(0, 60_000)`. A
// String property holds 64 KiB of UTF-16 — 32,768 characters — so a 60,000
// character value is rejected outright with PropertyValueTooLarge, and the
// caller throws. Slicing was also lossy in a second way: a sliced JSON string
// is not valid JSON, so anything that did fit came back unparseable.

const test = require('node:test');
const assert = require('node:assert');

const {
  MAX_PROP_CHARS, MAX_TOTAL_CHARS, packJson, unpackJson, packProperty, shrinkToFit
} = require('../src/lib/tablesafe');

const AZURE_PROP_CHAR_CAP = 32768; // 64 KiB / 2 bytes per UTF-16 code unit

// A payload shaped like the section that actually aborted the rollup:
// unbounded maps over every distinct pain string and tool name.
// 8000 keys ≈ 216k characters — comfortably past the 32,768-char property cap
// (so it must chunk) but inside the chunked ceiling (so nothing is dropped).
function bigDistributions(nKeys = 8000) {
  const painCounts = {};
  for (let i = 0; i < nKeys; i++) painCounts[`pain point number ${i}`] = i % 7;
  return { stances: { wary: 12 }, experience: { hobbyist: 9 }, painCounts };
}

test('the old slice(0, 60_000) approach exceeds the real property cap', () => {
  const oldWay = JSON.stringify(bigDistributions()).slice(0, 60_000);
  assert.strictEqual(oldWay.length, 60_000);
  assert.ok(oldWay.length > AZURE_PROP_CHAR_CAP,
    'a 60k-character property is over the 32,768-character ceiling Azure enforces');
  // And it is not even valid JSON any more.
  assert.throws(() => JSON.parse(oldWay));
});

test('a payload past the chunked ceiling is shrunk deliberately, not silently', () => {
  // 20k keys ≈ 560k characters — beyond even the 12-chunk entity budget.
  const { props, dropped } = packJson(bigDistributions(20000));
  assert.ok(dropped.includes('painCounts'), 'the unbounded map is the field dropped');
  const out = unpackJson(props);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.value.stances, { wary: 12 }, 'bounded fields survive');
  assert.deepStrictEqual(out.value._truncated.droppedFields, ['painCounts']);
});

test('no chunk ever exceeds the property cap', () => {
  const { props, chunks } = packJson(bigDistributions());
  assert.ok(chunks > 1, 'a payload this size must span several chunks');
  for (const [k, v] of Object.entries(props)) {
    if (k === 'jsonChunks') continue;
    assert.ok(typeof v === 'string');
    assert.ok(v.length <= MAX_PROP_CHARS, `${k} is ${v.length} chars, over the ${MAX_PROP_CHARS} budget`);
    assert.ok(v.length < AZURE_PROP_CHAR_CAP, `${k} would be rejected by Azure`);
  }
});

test('round-trips a large payload without loss', () => {
  const payload = bigDistributions();
  const { props } = packJson(payload);
  const out = unpackJson(props);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.value, payload);
});

test('round-trips small payloads in a single property', () => {
  const { props, chunks } = packJson({ utc: 1760000000 });
  assert.strictEqual(chunks, 1);
  assert.strictEqual(props.json1, undefined);
  assert.deepStrictEqual(unpackJson(props).value, { utc: 1760000000 });
});

test('reads a legacy single-property row that has no chunk count', () => {
  // Rows written before this round have `json` and no `jsonChunks`.
  const out = unpackJson({ json: '{"totalPosts":3}' });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.value, { totalPosts: 3 });
});

test('reports a legacy truncated row instead of throwing', () => {
  const out = unpackJson({ json: '{"totalPosts":3' }); // sliced by the old code
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /unparseable/);
});

test('stored output is always valid JSON, even when shrunk', () => {
  // Force the deliberate-shrink path with a payload past the chunked ceiling.
  const huge = { keep: 'small', fat: 'x'.repeat(MAX_TOTAL_CHARS + 5000) };
  const { props, dropped } = packJson(huge);
  assert.ok(dropped.includes('fat'), 'the largest field is the one dropped');
  const out = unpackJson(props);
  assert.strictEqual(out.ok, true, 'shrunk payloads still parse');
  assert.strictEqual(out.value.keep, 'small', 'the small field survives');
  assert.ok(out.value._truncated, 'truncation is recorded, not silent');
  assert.deepStrictEqual(out.value._truncated.droppedFields, ['fat']);
});

test('shrinkToFit drops the largest field first', () => {
  const { value, dropped } = shrinkToFit({ a: 'x'.repeat(100), b: 'y'.repeat(9000), c: 1 }, 4000);
  assert.deepStrictEqual(dropped, ['b']);
  assert.strictEqual(value.a.length, 100);
  assert.strictEqual(value.c, 1);
});

test('shrinkToFit leaves a payload that already fits completely alone', () => {
  const payload = { a: 1, b: [1, 2, 3] };
  const { value, dropped } = shrinkToFit(payload, 10000);
  assert.strictEqual(dropped.length, 0);
  assert.deepStrictEqual(value, payload);
});

test('packProperty keeps analysisJson parseable instead of slicing it', () => {
  const analysis = {
    ai_related: true,
    stance_on_ai: 'wary',
    summary: 'x'.repeat(MAX_PROP_CHARS + 5000), // oversized single field
    topics: ['craft-authenticity']
  };
  const { json, dropped } = packProperty(analysis);

  assert.ok(json.length <= MAX_PROP_CHARS, 'fits the property budget');
  const parsed = JSON.parse(json); // must not throw — this is the whole point
  assert.strictEqual(parsed.stance_on_ai, 'wary', 'the fields that matter survive');
  assert.strictEqual(parsed.ai_related, true);
  assert.ok(dropped.includes('summary'), 'the oversized field is dropped by name');
  assert.ok(parsed._truncated, 'and the row admits it was truncated');
});

test('packProperty leaves a normal analysis untouched', () => {
  const analysis = { ai_related: false, stance_on_ai: 'na', summary: 'short', topics: [] };
  const { json, dropped } = packProperty(analysis);
  assert.strictEqual(dropped.length, 0);
  assert.deepStrictEqual(JSON.parse(json), analysis);
});
