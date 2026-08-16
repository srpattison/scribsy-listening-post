'use strict';

// §3d — retroactive re-tag, and the §4 prompt-contamination measurement.
//
// The binding constraint on both is ZERO MODEL CALLS. Exclusion changes the
// aggregate without touching any row's analysisJson; the contamination scan is
// read-only and exists to turn "some unknown fraction of the corpus" into a
// counted, per-partition list that can be priced. Remediation is a budget
// decision and is never triggered from here.

const test = require('node:test');
const assert = require('node:assert');

const { runRetag, scanContamination, quotesFrom } = require('../src/lib/retag');

const RULE_TEXT =
  'Please read the rules before posting. Requests for critique must include a ' +
  'sample of your own work. AI generated feedback and reviews is also not allowed. ' +
  'Low effort posts will be removed by the moderators without warning.';

// A store whose every mutating entry point is spied on.
function spyStore({ rows = [], raws = {}, analyzed = [] } = {}) {
  const calls = { enqueueAnalysis: 0, enqueueBackfill: 0, saveAnalysis: 0, setContentClass: [] };
  const aggregates = new Map();
  return {
    calls,
    aggregates,
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
    setContentClass: async (pk, rk, cls, reason) => { calls.setContentClass.push({ pk, rk, cls, reason }); },
    // Anything that would cost money:
    enqueueAnalysis: async () => { calls.enqueueAnalysis++; },
    enqueueBackfill: async () => { calls.enqueueBackfill++; },
    saveAnalysis: async () => { calls.saveAnalysis++; }
  };
}

const silent = { log() {}, warn() {}, error() {} };

const megathread = (i) => ({
  partitionKey: 'betareaders', rowKey: `bot${i}`, author: 'AutoModerator',
  title: 'Able to beta? Post here! Weekly beta reader matching thread', createdUtc: 1_760_000_000 + i
});
const writer = (i) => ({
  partitionKey: 'betareaders', rowKey: `hum${i}`, author: `writer_${i}`,
  title: `Beta swap for my SF novella part ${i}`, createdUtc: 1_760_100_000 + i
});

test('retag enqueues zero analysis jobs', async () => {
  const store = spyStore({ rows: [...Array.from({ length: 8 }, (_, i) => megathread(i)), ...Array.from({ length: 4 }, (_, i) => writer(i))] });
  const out = await runRetag({ store, context: silent });

  assert.strictEqual(store.calls.enqueueAnalysis, 0, 'retag must never enqueue analysis');
  assert.strictEqual(store.calls.enqueueBackfill, 0);
  assert.strictEqual(store.calls.saveAnalysis, 0, 'retag must never rewrite analysisJson');
  assert.strictEqual(out.analysisJobsEnqueued, 0);
});

test('retag tags the megathreads and reports byReason / byPartition', async () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => megathread(i)),
    ...Array.from({ length: 4 }, (_, i) => writer(i)),
    { partitionKey: 'writing', rowKey: 'w1', author: 'someone', title: 'On drafting', createdUtc: 1 }
  ];
  const out = await runRetag({ store: spyStore({ rows }), context: silent });

  assert.strictEqual(out.scanned, 13);
  assert.strictEqual(out.tagged.bot, 8);
  assert.strictEqual(out.tagged.human, 5);
  assert.strictEqual(out.byReason['automod-author'], 8);
  assert.deepStrictEqual(out.byPartition.betareaders, { bot: 8, boilerplate: 0 });
  assert.strictEqual(out.byPartition.writing, undefined, 'clean subs are not listed');
});

test('retag writes only the classification columns', async () => {
  const store = spyStore({ rows: [megathread(0), writer(0)] });
  await runRetag({ store, context: silent });
  assert.deepStrictEqual(store.calls.setContentClass, [
    { pk: 'betareaders', rk: 'bot0', cls: 'bot', reason: 'automod-author' },
    { pk: 'betareaders', rk: 'hum0', cls: 'human', reason: '' }
  ]);
});

test('retag skips rows already carrying the right class', async () => {
  const rows = [
    { ...megathread(0), contentClass: 'bot', contentClassReason: 'automod-author' },
    writer(0)
  ];
  const store = spyStore({ rows });
  const out = await runRetag({ store, context: silent });
  assert.strictEqual(out.changed, 1, 'only the untagged row is written');
  assert.deepStrictEqual(store.calls.setContentClass.map((c) => c.rk), ['hum0']);
});

test('dryRun reports without writing', async () => {
  const store = spyStore({ rows: [megathread(0), megathread(1)] });
  const out = await runRetag({ store, context: silent, dryRun: true });
  assert.strictEqual(out.dryRun, true);
  assert.strictEqual(out.tagged.bot, 2);
  assert.strictEqual(store.calls.setContentClass.length, 0, 'nothing written in a dry run');
});

test('body hashing is opt-in and reports its cap', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    partitionKey: 'betareaders', rowKey: `t${i}`, author: `writer_${i}`,
    title: `unique title ${i}`, createdUtc: 1_760_000_000 + i
  }));
  const raws = {};
  for (let i = 0; i < 8; i++) {
    raws[`betareaders|t${i}|post`] = { post: { selftext: RULE_TEXT }, comments: [] };
  }

  const withoutBodies = await runRetag({ store: spyStore({ rows, raws }), context: silent });
  assert.strictEqual(withoutBodies.tagged.boilerplate, 0, 'titles differ, so the default pass sees nothing');
  assert.strictEqual(withoutBodies.bodies.read, 0, 'no blob reads unless asked');

  const withBodies = await runRetag({ store: spyStore({ rows, raws }), context: silent, bodies: true });
  assert.strictEqual(withBodies.tagged.boilerplate, 8, 'body repeat-hash catches the shared template');
  assert.strictEqual(withBodies.bodies.read, 8);
  assert.strictEqual(withBodies.bodies.capped, false);

  const capped = await runRetag({ store: spyStore({ rows, raws }), context: silent, bodies: true, bodyLimit: 3 });
  assert.strictEqual(capped.bodies.capped, true, 'a truncated pass must say so, never look complete');
  assert.strictEqual(capped.bodies.read, 3);
});

test('a missing raw blob degrades to title + signals instead of failing', async () => {
  const rows = [megathread(0), writer(0)];
  const out = await runRetag({ store: spyStore({ rows, raws: {} }), context: silent, bodies: true });
  assert.strictEqual(out.tagged.bot, 1, 'the author signal still fires');
  assert.strictEqual(out.bodies.read, 0);
});

// ---------------------------------------------------------------------------
// §4 measurement — narrow vs broad prompt contamination
// ---------------------------------------------------------------------------

const analysisQuoting = (quote) => JSON.stringify({
  ai_related: true, stance_on_ai: 'hostile',
  notable_quote: quote,
  trust_signals: [{ direction: 'breaks', signal: 'x', quote }],
  comment_stance_mix: { hostile: 3 }
});
const analysisClean = JSON.stringify({
  ai_related: true, stance_on_ai: 'curious',
  notable_quote: 'I have been drafting every morning and it is finally sticking.',
  comment_stance_mix: { curious: 2 }
});

test('quotesFrom pulls every verbatim field the schema demands', () => {
  const a = JSON.parse(analysisQuoting(RULE_TEXT));
  const qs = quotesFrom(a);
  assert.strictEqual(qs.length, 2, 'notable_quote plus the trust_signals quote');
  assert.ok(qs.every((q) => q === RULE_TEXT));
});

test('narrow and broad are counted separately, per partition', async () => {
  const botComment = { author: 'AutoModerator', body: RULE_TEXT };
  const humanComment = { author: 'someone', body: 'I would read that, send me chapter one.' };

  const analyzed = [
    // 1. bot comment in the prompt AND its text lifted into a quote → narrow + broad
    { partitionKey: 'betareaders', rowKey: 'a', createdUtc: 1, analysisJson: analysisQuoting(RULE_TEXT) },
    // 2. bot comment in the prompt, nothing lifted → broad only.
    //    comment_stance_mix is still unreliable, which is why broad is the
    //    criterion that matters and narrow undercounts.
    { partitionKey: 'betareaders', rowKey: 'b', createdUtc: 1, analysisJson: analysisClean },
    // 3. only human comments → clean
    { partitionKey: 'writing', rowKey: 'c', createdUtc: 1, analysisJson: analysisClean },
    // 4. no comments were ever fetched → not eligible at all
    { partitionKey: 'writing', rowKey: 'd', createdUtc: 1, analysisJson: analysisClean }
  ];
  const raws = {
    'betareaders|a|post': { post: {}, comments: [botComment, humanComment] },
    'betareaders|b|post': { post: {}, comments: [botComment] },
    'writing|c|post': { post: {}, comments: [humanComment] },
    'writing|d|post': { post: {}, comments: [] }
  };

  const store = spyStore({ analyzed, raws });
  const out = await scanContamination({ store, context: silent });

  assert.strictEqual(store.calls.enqueueAnalysis, 0, 'the measurement must cost nothing');
  assert.strictEqual(out.analysisJobsEnqueued, 0);

  assert.strictEqual(out.rowsWithComments, 3, 'row d had no comments and is not eligible');
  assert.strictEqual(out.broad, 2, 'rows a and b had a bot comment in the prompt');
  assert.strictEqual(out.narrow, 1, 'only row a lifted its text into a quote');
  assert.ok(out.narrow < out.broad, 'narrow undercounts by construction — that is the point');

  assert.deepStrictEqual(out.byPartition.betareaders, { eligible: 2, narrow: 1, broad: 2 });
  assert.deepStrictEqual(out.byPartition.writing, { eligible: 1, narrow: 0, broad: 0 });
});

test('the scan reports its own cap rather than looking complete', async () => {
  const analyzed = Array.from({ length: 10 }, (_, i) => ({
    partitionKey: 'writing', rowKey: `r${i}`, createdUtc: 1, analysisJson: analysisClean
  }));
  const raws = {};
  for (let i = 0; i < 10; i++) raws[`writing|r${i}|post`] = { post: {}, comments: [{ author: 'x', body: 'hi' }] };

  const out = await scanContamination({ store: spyStore({ analyzed, raws }), context: silent, limit: 4 });
  assert.strictEqual(out.capped, true);
  assert.strictEqual(out.rowsScanned, 4);
});

// ---------------------------------------------------------------------------
// §3d — a long-running operation must not depend on its response arriving
// ---------------------------------------------------------------------------
//
// POST /api/retag?contamination=1 hit the 4:00 Azure gateway cut on 2026-08-16.
// The narrow/broad counts existed only in the severed response and were simply
// lost, so the remediation could not be priced.

test('retag persists its report before returning', async () => {
  const store = spyStore({ rows: [megathread(0), writer(0)] });
  const returned = await runRetag({ store, context: silent });

  const persisted = store.aggregates.get('retag|latest');
  assert.ok(persisted, 'the report must exist in aggregates, not only in the response');
  assert.strictEqual(persisted.tagged.bot, returned.tagged.bot);
  assert.strictEqual(persisted.scanned, returned.scanned);

  const dated = [...store.aggregates.keys()].filter((k) => k.startsWith('retag|') && k !== 'retag|latest');
  assert.strictEqual(dated.length, 1, 'plus a dated snapshot');
});

test('the report is persisted even when the body pass self-caps', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    partitionKey: 'betareaders', rowKey: `t${i}`, author: `w${i}`, title: `t${i}`, createdUtc: 1 + i
  }));
  const raws = {};
  for (let i = 0; i < 10; i++) raws[`betareaders|t${i}|post`] = { post: { selftext: RULE_TEXT }, comments: [] };

  const store = spyStore({ rows, raws });
  const out = await runRetag({ store, context: silent, bodies: true, bodyLimit: 4 });

  assert.strictEqual(out.bodies.capped, true);
  assert.ok(out.bodies.resumeAfter, 'a capped run records where to continue from');
  const persisted = store.aggregates.get('retag|latest');
  assert.ok(persisted, 'a capped run still persists its report');
  assert.strictEqual(persisted.bodies.capped, true);
  assert.strictEqual(persisted.bodies.resumeAfter, out.bodies.resumeAfter);
});

test('a capped body pass resumes rather than restarting', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    partitionKey: 'betareaders', rowKey: `t${i}`, author: `w${i}`, title: `t${i}`, createdUtc: 1 + i
  }));
  const raws = {};
  for (let i = 0; i < 6; i++) raws[`betareaders|t${i}|post`] = { post: { selftext: `body ${i}` }, comments: [] };

  const first = await runRetag({ store: spyStore({ rows, raws }), context: silent, bodies: true, bodyLimit: 3 });
  assert.strictEqual(first.bodies.read, 3);

  const second = await runRetag({
    store: spyStore({ rows, raws }), context: silent, bodies: true, bodyLimit: 3,
    bodiesAfter: first.bodies.resumeAfter
  });
  assert.strictEqual(second.bodies.read, 3, 'the second pass reads the remaining rows, not the same three');
  assert.strictEqual(second.bodies.capped, false, 'and reaches the end of the table');
});

test('a dry run neither writes tags nor persists a report', async () => {
  const store = spyStore({ rows: [megathread(0)] });
  await runRetag({ store, context: silent, dryRun: true });
  assert.strictEqual(store.calls.setContentClass.length, 0);
  assert.strictEqual(store.aggregates.get('retag|latest'), undefined);
});

test('retag publishes discovered hashes to the boilerplate registry', async () => {
  // Eight rows sharing a long body, distinct ordinary authors — the general
  // detector's case. The hashes must reach the registry so the analyze path can
  // apply repeat-hash at point-of-analysis.
  const rows = Array.from({ length: 8 }, (_, i) => ({
    partitionKey: 'betareaders', rowKey: `t${i}`, author: `writer_${i}`,
    title: `unique title ${i}`, createdUtc: 1 + i
  }));
  const raws = {};
  for (let i = 0; i < 8; i++) raws[`betareaders|t${i}|post`] = { post: { selftext: RULE_TEXT }, comments: [] };

  const store = spyStore({ rows, raws });
  const out = await runRetag({ store, context: silent, bodies: true });

  assert.strictEqual(out.registry.subsWritten, 1);
  const row = store.aggregates.get('boilerplate-registry|betareaders');
  assert.ok(row, 'a registry row must exist for the sub');
  assert.ok(Object.keys(row.hashes).length >= 1);
});

test('the contamination scan persists its report and its resume cursor', async () => {
  const analyzed = Array.from({ length: 10 }, (_, i) => ({
    partitionKey: 'writing', rowKey: `r${i}`, createdUtc: 1, analysisJson: analysisClean
  }));
  const raws = {};
  for (let i = 0; i < 10; i++) raws[`writing|r${i}|post`] = { post: {}, comments: [{ author: 'x', body: 'hi' }] };

  const store = spyStore({ analyzed, raws });
  const out = await scanContamination({ store, context: silent, limit: 4 });

  const persisted = store.aggregates.get('retag-contamination|latest');
  assert.ok(persisted, 'the counts must survive a severed response');
  assert.strictEqual(persisted.narrow, out.narrow);
  assert.strictEqual(persisted.broad, out.broad);
  assert.strictEqual(persisted.capped, true);
  assert.ok(persisted.resumeAfter, 'a capped scan records where to continue from');
});

test('a capped contamination scan resumes rather than rescanning', async () => {
  const analyzed = Array.from({ length: 6 }, (_, i) => ({
    partitionKey: 'writing', rowKey: `r${i}`, createdUtc: 1, analysisJson: analysisClean
  }));
  const raws = {};
  for (let i = 0; i < 6; i++) raws[`writing|r${i}|post`] = { post: {}, comments: [{ author: 'x', body: 'hi' }] };

  const first = await scanContamination({ store: spyStore({ analyzed, raws }), context: silent, limit: 3 });
  assert.strictEqual(first.rowsScanned, 3);

  const second = await scanContamination({
    store: spyStore({ analyzed, raws }), context: silent, limit: 3, after: first.resumeAfter
  });
  assert.strictEqual(second.rowsScanned, 3);
  assert.strictEqual(second.capped, false, 'the second pass finishes the table');
});

test('repeat-hash catches non-AutoModerator sticky text in comments', async () => {
  // Removal notices and critique-thread bots that nobody enumerated: identical
  // long comment text recurring across threads in one sub.
  const analyzed = Array.from({ length: 8 }, (_, i) => ({
    partitionKey: 'destructivereaders', rowKey: `r${i}`, createdUtc: 1, analysisJson: analysisClean
  }));
  const raws = {};
  for (let i = 0; i < 8; i++) {
    raws[`destructivereaders|r${i}|post`] = {
      post: {},
      comments: [{ author: `mod_helper_${i}`, body: RULE_TEXT }]
    };
  }
  const out = await scanContamination({ store: spyStore({ analyzed, raws }), context: silent });
  assert.strictEqual(out.broad, 8, 'the general detector must not depend on an author allowlist');
});
