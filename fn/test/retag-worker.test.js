'use strict';

// §8m (CB-LISTEN-REPO-7) — the retag body/contamination scan converted to a
// self-requeuing queue worker, same shape as backfillWorker. runRetag/
// scanContamination themselves are already tested (test/retag.test.js); this
// file verifies the WORKER shape around them: cumulative progress tracking
// across chunks (retag-queue-status) and the capped→exhausted transition
// that decides whether functions/retag.js re-enqueues itself.

const test = require('node:test');
const assert = require('node:assert');

const { runRetagChunk, QUEUE_STATUS_PARTITION } = require('../src/lib/retag-worker');

const silent = { log() {}, warn() {}, error() {} };

function spyStore({ rows = [], raws = {}, analyzed = [] } = {}) {
  const aggregates = new Map();
  return {
    aggregates,
    ensureInfra: async () => {},
    listRowsForRetag: async () => rows,
    listAnalyzedPosts: async () => analyzed,
    saveAggregate: async (p, k, v) => { aggregates.set(`${p}|${k}`, v); },
    getAggregate: async (p, k) => aggregates.get(`${p}|${k}`) || null,
    listAggregates: async (p) => [...aggregates.entries()]
      .filter(([key]) => key.startsWith(`${p}|`))
      .map(([key, v]) => ({ period: key.split('|')[1], ...v })),
    getRaw: async (sub, utc, id, kind) => {
      const key = `${sub}|${id}|${kind || 'post'}`;
      if (!(key in raws)) throw new Error('blob missing');
      return raws[key];
    },
    setContentClass: async () => {}
  };
}

const RULE_TEXT = 'Please read the rules before posting. AI generated feedback is also not allowed at all in this community for any writer here.';

const writer = (i) => ({
  partitionKey: 'betareaders', rowKey: `hum${i}`, author: `writer_${i}`,
  title: `Beta swap for my SF novella part ${i}`, createdUtc: 1_760_100_000 + i
});

test('§8m: the bodies chunk caps at chunkSize, tracks cumulative readTotal, and reports exhausted only once done', async () => {
  const rows = [writer(0), writer(1)];
  const raws = {
    'betareaders|hum0|post': { post: { title: writer(0).title, selftext: 'x'.repeat(150) }, comments: [] },
    'betareaders|hum1|post': { post: { title: writer(1).title, selftext: 'y'.repeat(150) }, comments: [] }
  };
  const storeImpl = spyStore({ rows, raws });

  const first = await runRetagChunk({ kind: 'bodies', chunkSize: 1 }, silent, { storeImpl });
  assert.strictEqual(first.capped, true, 'chunkSize=1 against 2 rows must cap the first chunk');
  const statusAfterFirst = storeImpl.aggregates.get(`${QUEUE_STATUS_PARTITION}|bodies`);
  assert.strictEqual(statusAfterFirst.readTotal, 1);
  assert.strictEqual(statusAfterFirst.exhausted, false);

  const second = await runRetagChunk({ kind: 'bodies', chunkSize: 1, after: first.resumeAfter }, silent, { storeImpl });
  assert.strictEqual(second.capped, false, 'the second chunk must exhaust the 2-row corpus');
  const statusAfterSecond = storeImpl.aggregates.get(`${QUEUE_STATUS_PARTITION}|bodies`);
  assert.strictEqual(statusAfterSecond.readTotal, 2, 'progress must ACCUMULATE across chunks, not reset');
  assert.strictEqual(statusAfterSecond.exhausted, true);
});

test('§8m: the contamination chunk caps at chunkSize, tracks cumulative readTotal, and reports exhausted only once done', async () => {
  const analyzed = [
    { partitionKey: 'betareaders', rowKey: 'hum0', createdUtc: 1_760_100_000, analysisJson: '{}' },
    { partitionKey: 'betareaders', rowKey: 'hum1', createdUtc: 1_760_100_001, analysisJson: '{}' }
  ];
  const raws = {
    'betareaders|hum0|post': { post: {}, comments: [{ author: 'AutoModerator', body: RULE_TEXT }] },
    'betareaders|hum1|post': { post: {}, comments: [{ author: 'AutoModerator', body: RULE_TEXT }] }
  };
  const storeImpl = spyStore({ analyzed, raws });

  const first = await runRetagChunk({ kind: 'contamination', chunkSize: 1 }, silent, { storeImpl });
  assert.strictEqual(first.capped, true);
  assert.strictEqual(storeImpl.aggregates.get(`${QUEUE_STATUS_PARTITION}|contamination`).readTotal, 1);

  const second = await runRetagChunk({ kind: 'contamination', chunkSize: 1, after: first.resumeAfter }, silent, { storeImpl });
  assert.strictEqual(second.capped, false);
  const finalStatus = storeImpl.aggregates.get(`${QUEUE_STATUS_PARTITION}|contamination`);
  assert.strictEqual(finalStatus.readTotal, 2, 'progress must ACCUMULATE across chunks');
  assert.strictEqual(finalStatus.exhausted, true);
});

test('§8o via §8m: a completed contamination scan (repeats > minRepeats) writes comment-derived registry hashes', async () => {
  // 8 rows so the shared comment text clears the default minRepeats=5 floor —
  // this is what §8o requires: the harvest is a real effect of the scan
  // actually completing, not of author-based detection alone.
  const analyzed = Array.from({ length: 8 }, (_, i) => ({
    partitionKey: 'betareaders', rowKey: `hum${i}`, createdUtc: 1_760_100_000 + i, analysisJson: '{}'
  }));
  const raws = Object.fromEntries(analyzed.map((r) =>
    [`betareaders|${r.rowKey}|post`, { post: {}, comments: [{ author: `person_${r.rowKey}`, body: RULE_TEXT }] }]));
  const storeImpl = spyStore({ analyzed, raws });

  const result = await runRetagChunk({ kind: 'contamination', chunkSize: 20 }, silent, { storeImpl });
  assert.strictEqual(result.capped, false, 'a single chunk of 20 against 8 rows must fully exhaust');

  const registryRow = storeImpl.aggregates.get('boilerplate-registry|betareaders');
  assert.ok(registryRow, 'the contamination scan must write to the boilerplate registry once repeats qualify');
  const hashes = Object.values(registryRow.hashes);
  assert.ok(hashes.some((h) => h.kind === 'comment-body'),
    'the harvested hash must be tagged comment-body, not the generic body kind retag uses (§8o)');
});
