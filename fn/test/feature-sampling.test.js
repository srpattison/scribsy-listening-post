'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectFeatures } = require('../src/lib/feature-sampling');

test('feature sample includes later source/time groups and is invariant to storage order', () => {
  const entries = Array.from({ length: 800 }, (_, i) => ({
    partitionKey: i < 700 ? 'writing' : 'bsky-writersky', rowKey: String(i),
    source: i < 700 ? 'reddit' : 'bluesky', kind: i % 2 ? 'comment' : 'post',
    createdUtc: i < 700 ? 1700000000 : 1760000000,
    value: { name: `feature-${i}`, aiRelated: i % 3 === 0 }
  }));
  const a = selectFeatures(entries), b = selectFeatures([...entries].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.selected.length, 400);
  assert.equal(a.coverage.population, 800);
  assert.equal(a.coverage.strata.length, 4);
  assert.ok(a.coverage.strata.every(s => s.selected > 0));
  assert.ok(a.selected.some(f => Number(f.name.split('-')[1]) >= 700));
  assert.ok(a.selected.some(f => !f.aiRelated));
  assert.ok(a.selected.every(f => !('rowKey' in f)));
});
test('empty feature population is explicitly empty', () => {
  assert.equal(selectFeatures([]).coverage.selected, 0);
});
