'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { filterContributions, prepareContributions, runSourceCheckedRollup } = require('../src/lib/contribution-filter');
const rule = 'Please follow the submission template before requesting feedback.';
const opinion = 'I want my writing tools to preserve my individual voice.';
const row = (id = 'a') => ({ partitionKey: 'writing', rowKey: id, createdUtc: 1700000000,
  author: 'writer', title: 'My writing workflow', contentClass: 'human',
  analysisJson: JSON.stringify({ ai_related: true, notable_quote: rule,
    feature_requests: [{ feature: 'template', quote: rule }, { feature: 'voice', quote: opinion }],
    deal_breakers: [{ item: 'template', quote: rule }], trust_signals: [{ signal: 'template', quote: rule }] }) });
const raw = { post: { author: 'writer', selftext: opinion }, comments: [{ author: 'AutoModerator', body: rule }] };

test('confirmed bot contributions are removed atomically; human features and original analysis survive', () => {
  const input = row(), before = input.analysisJson;
  const result = filterContributions(input, raw, new Set());
  const a = JSON.parse(result.row.analysisJson);
  assert.equal(a.notable_quote, '');
  assert.deepEqual(a.feature_requests, [{ feature: 'voice', quote: opinion }]);
  assert.deepEqual(a.deal_breakers, []); assert.deepEqual(a.trust_signals, []);
  assert.equal(result.audit.excluded.length, 4);
  assert.equal(input.analysisJson, before);
});
test('human/bot ambiguity, repeated genuine opinions, unmatched text and short fragments are retained', () => {
  const ambiguous = { ...raw, post: { author: 'writer', selftext: `${opinion} ${rule}` } };
  assert.equal(filterContributions(row(), ambiguous).audit.excluded.length, 0);
  for (let i = 0; i < 8; i++) {
    const r = row(String(i));
    const a = JSON.parse(r.analysisJson); a.notable_quote = opinion;
    a.feature_requests = [{ feature: 'voice', quote: opinion }, { feature: 'unknown', quote: 'This exact quotation is absent from every source.' }, { feature: 'short', quote: 'template' }];
    a.deal_breakers = []; a.trust_signals = []; r.analysisJson = JSON.stringify(a);
    assert.equal(filterContributions(r, raw).audit.excluded.length, 0);
  }
});
test('multiple filtered origins are sufficient, while registry repetition alone is not', () => {
  const repeated = { ...raw, comments: [...raw.comments, { author: 'mod', distinguished: 'moderator', body: rule }] };
  assert.equal(filterContributions(row(), repeated).audit.excluded.length, 4);
  const text = opinion.repeat(3), registry = new Set([require('../src/lib/content-class').hashIfEligible(text)]);
  const r = row(); r.analysisJson = JSON.stringify({ notable_quote: opinion });
  assert.equal(filterContributions(r, { post: { selftext: text } }, registry).audit.excluded.length, 0);
});
test('bounded source reads preserve row order and report missing-source denominators', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => row(String(i)));
  const result = await prepareContributions(rows, { getRaw: async (_sub, _date, id) => {
    if (id === '3') throw new Error('private failure'); return raw;
  } }, new Map(), { concurrency: 2 });
  assert.deepEqual(result.rows.map(r => r.rowKey), rows.map(r => r.rowKey));
  assert.equal(result.health.checkedRows, 6); assert.equal(result.health.unavailableRows, 1);
  assert.equal(result.health.excluded.count, 24); assert.equal(result.health.degraded, true);
  assert.ok(!JSON.stringify(result.health).includes('private failure'));
});
test('production preflight refuses missing raw sources before any aggregate or model writes', async () => {
  let writes = 0;
  await assert.rejects(runSourceCheckedRollup({ store: { listAnalyzedPosts: async () => [row()],
    getAggregate: async () => null, getRaw: async () => null, saveAggregate: async () => { writes++; } },
    aoai: {} }), /no aggregates written/);
  assert.equal(writes, 0);
});
test('production wiring removes contaminated feature counts and examples, quotes and persona inputs together', async () => {
  const saved = new Map(); let personaSample;
  const store = { listAnalyzedPosts: async () => [row()], getRaw: async () => raw,
    getAggregate: async () => null, saveAggregate: async (p, k, value) => saved.set(p, value) };
  const aoai = { normalizeFeatures: async names => ({ groups: names.map((canonical, i) => ({ canonical, members: [i] })) }),
    synthesizePersonas: async sample => { personaSample = sample; return { personas: [] }; },
    standingQuestions: () => [], strategyBrief: async () => ({ answers: [] }) };
  const result = await runSourceCheckedRollup({ store, aoai, env: { SUBREDDITS: 'writing', SUB_TAGS: '{}', BSKY_STREAMS: '[]' }, context: { log() {}, warn() {}, error() {} } });
  assert.equal(result.contributionHealth.excluded.count, 4);
  assert.equal(saved.get('features').totalNames, 1);
  assert.equal(saved.get('features').featureBoard[0].feature, 'voice');
  assert.equal(saved.get('features').featureBoard[0].count, 1);
  assert.equal(saved.get('features').featureBoard[0].examples[0].quote, opinion);
  assert.deepEqual(saved.get('quotes').quotes, []);
  assert.ok(personaSample.every(item => item.quote === ''));
});
