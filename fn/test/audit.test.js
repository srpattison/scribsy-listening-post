'use strict';

// CB-LISTEN-REPO-6 §8 (adopted verbatim by CB-LISTEN-REPO-7 §1) — the corpus
// quality audit. §9 names five checks that MUST be verified against a fixture
// engineered to trip them, not merely against real data that may happen to be
// clean: §8a, §8b, §8c, §8f, §8g. Those five get dedicated fixture tests
// below; §8d/§8e/§8h/§8i/§8j get direct coverage too, at lighter depth.

const test = require('node:test');
const assert = require('node:assert');

const auditLib = require('../src/lib/audit');
const { runAuditChunk, loadAccumulator, ACCUMULATOR_NAME } = require('../src/lib/audit-worker');
const tablesafe = require('../src/lib/tablesafe');

const noopContext = { log() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// §8a — quote provenance and fidelity (REQUIRED fixture per §9)
// ---------------------------------------------------------------------------

test('§8a: a quote lifted from a bot comment lands in bot-comment, not post-body', () => {
  const postText = 'I have been drafting my novel for two years and want feedback on pacing.';
  const botQuote = 'AI generated feedback and reviews is also not allowed on this subreddit per the rules.';
  const bucket = auditLib.classifyQuote(botQuote, {
    postText,
    humanBodies: ['I would love to beta read this for you, send it over!'],
    botBodies: [botQuote]
  });
  assert.strictEqual(bucket, 'bot-comment');
});

test('§8a: a fabricated quote that appears nowhere in source text lands in not-found', () => {
  const bucket = auditLib.classifyQuote(
    'This exact sentence was never written by anyone in this thread at all.',
    { postText: 'Totally unrelated post body text about outlining a fantasy trilogy.', humanBodies: [], botBodies: [] }
  );
  assert.strictEqual(bucket, 'not-found');
});

test('§8a: a classifier that defaults everything to post-body would fail this pair (proves the check can fail)', () => {
  const postText = 'My post is about querying agents for my manuscript.';
  const botQuote = 'Requests for critique must include a sample of your own work per the rules.';
  const fabricated = 'Nobody anywhere said this specific sentence in this thread.';

  const bogus = () => 'post-body'; // the failure mode §9 calls out
  assert.notStrictEqual(bogus(), auditLib.classifyQuote(botQuote, { postText, humanBodies: [], botBodies: [botQuote] }));
  assert.notStrictEqual(bogus(), auditLib.classifyQuote(fabricated, { postText, humanBodies: [], botBodies: [] }));
});

test('§8a end-to-end: scanChunk buckets quotes correctly across post-body/human-comment/bot-comment/not-found', async () => {
  const RULE_TEXT = 'Please read the rules before posting. AI generated feedback and reviews is also not allowed here at all in this community space.';
  const rows = [{
    partitionKey: 'betareaders', rowKey: 'p1', createdUtc: 1_760_000_000, permalink: '/r/betareaders/p1/',
    analysisJson: JSON.stringify({
      notable_quote: 'This is the authors own vivid sentence about their draft manuscript right here.',
      deal_breakers: [{ item: 'x', kind: 'privacy', quote: RULE_TEXT }],
      trust_signals: [],
      feature_requests: [{ feature: 'y', ai_related: false, quote: 'A sentence that was fabricated and appears nowhere in any source text at all.' }]
    })
  }];
  const fakeStore = {
    getRaw: async () => ({
      post: { title: 'My draft', selftext: 'This is the authors own vivid sentence about their draft manuscript right here.' },
      comments: [
        { author: 'AutoModerator', body: RULE_TEXT },
        { author: 'a_writer', body: 'happy to beta read, send it my way' }
      ]
    })
  };
  const chunk = await auditLib.scanChunk({
    store: fakeStore, context: noopContext, analyzedRows: rows, limit: 10, after: null,
    registryFor: async () => new Set()
  });
  const counts = chunk.quoteCounts.betareaders;
  assert.strictEqual(counts['post-body'], 1, 'notable_quote is the post\'s own words');
  assert.strictEqual(counts['bot-comment'], 1, 'the deal_breaker quote was lifted from AutoModerator');
  assert.strictEqual(counts['not-found'], 1, 'the feature_request quote was fabricated');
  assert.strictEqual(chunk.quoteSamples.betareaders['bot-comment'].length, 1);
  assert.strictEqual(chunk.quoteSamples.betareaders['not-found'].length, 1);
});

// ---------------------------------------------------------------------------
// §8b — author concentration (REQUIRED fixture per §9)
// ---------------------------------------------------------------------------

test('§8b: a fixture engineered so one author dominates AI-related content is reflected in top1Pct/top10Pct share', () => {
  const rows = [
    ...Array.from({ length: 40 }, (_, i) => ({
      partitionKey: 'writing', author: 'prolific_poster', analyzed: true, aiRelated: true, rowKey: `dom${i}`
    })),
    ...Array.from({ length: 60 }, (_, i) => ({
      partitionKey: 'writing', author: `writer_${i}`, analyzed: true, aiRelated: true, rowKey: `h${i}`
    }))
  ];
  const { authorConcentration } = auditLib.tableChecks(rows);
  assert.strictEqual(authorConcentration.totalAuthors, 61);
  assert.strictEqual(authorConcentration.totalAiRelated, 100);
  assert.strictEqual(authorConcentration.top20[0].author, 'prolific_poster');
  assert.strictEqual(authorConcentration.top20[0].aiRelatedPosts, 40);
  // top 1% of 61 authors = 1 author = prolific_poster alone = 40/100 = 0.4
  assert.strictEqual(authorConcentration.top1PctShare, 0.4);
  assert.ok(authorConcentration.top1PctShare > 0.3,
    'a fixture with one dominant author must show a large top-1% share, or the check has never fired');
});

test('§8b: a flat fixture (no dominant author) shows a small top1Pct share (negative control)', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    partitionKey: 'writing', author: `writer_${i}`, analyzed: true, aiRelated: true, rowKey: `r${i}`
  }));
  const { authorConcentration } = auditLib.tableChecks(rows);
  assert.ok(authorConcentration.top1PctShare <= 0.02, 'no single author should dominate a flat fixture');
});

// ---------------------------------------------------------------------------
// §8c — duplicate and crosspost detection (REQUIRED fixture per §9)
// ---------------------------------------------------------------------------

const DUP_BODY = 'This exact submission template text is long enough to clear the duplicate-hash floor and recurs verbatim across more than one subreddit in this fixture.';

test('§8c: the same body posted to two different subs is counted as a crosspost, not a repost', async () => {
  const rows = [
    { partitionKey: 'writing', rowKey: 'a', createdUtc: 1_760_000_000, permalink: '/r/writing/a/' },
    { partitionKey: 'fantasywriters', rowKey: 'b', createdUtc: 1_760_000_100, permalink: '/r/fantasywriters/b/' }
  ];
  const fakeStore = { getRaw: async (sub) => ({ post: { title: 't', selftext: DUP_BODY }, comments: [] }) };
  const chunk = await auditLib.scanChunk({
    store: fakeStore, context: noopContext, analyzedRows: rows, limit: 10, after: null,
    registryFor: async () => new Set()
  });
  const acc = auditLib.mergeChunk(null, chunk);
  const dup = auditLib.duplicateSummary(acc);
  assert.strictEqual(dup.crosspostHashes, 1);
  assert.strictEqual(dup.crosspostRows, 2);
  assert.strictEqual(dup.repostHashes, 0);
});

test('§8c: the same body posted twice within ONE sub is counted as a repost, not a crosspost', async () => {
  const rows = [
    { partitionKey: 'writing', rowKey: 'a', createdUtc: 1_760_000_000, permalink: '/r/writing/a/' },
    { partitionKey: 'writing', rowKey: 'b', createdUtc: 1_760_000_100, permalink: '/r/writing/b/' }
  ];
  const fakeStore = { getRaw: async () => ({ post: { title: 't', selftext: DUP_BODY }, comments: [] }) };
  const chunk = await auditLib.scanChunk({
    store: fakeStore, context: noopContext, analyzedRows: rows, limit: 10, after: null,
    registryFor: async () => new Set()
  });
  const acc = auditLib.mergeChunk(null, chunk);
  const dup = auditLib.duplicateSummary(acc);
  assert.strictEqual(dup.repostHashes, 1);
  assert.strictEqual(dup.repostRows, 2);
  assert.strictEqual(dup.crosspostHashes, 0);
});

test('§8c: two rows with genuinely unrelated bodies are neither a crosspost nor a repost (negative control)', async () => {
  const rows = [
    { partitionKey: 'writing', rowKey: 'a', createdUtc: 1_760_000_000, permalink: '/r/writing/a/' },
    { partitionKey: 'fantasywriters', rowKey: 'b', createdUtc: 1_760_000_100, permalink: '/r/fantasywriters/b/' }
  ];
  let call = 0;
  const bodies = [DUP_BODY, 'A completely different, unrelated body of sufficient length to also clear the duplicate-hash floor on its own merits here.'];
  const fakeStore = { getRaw: async () => ({ post: { title: 't', selftext: bodies[call++] }, comments: [] }) };
  const chunk = await auditLib.scanChunk({
    store: fakeStore, context: noopContext, analyzedRows: rows, limit: 10, after: null,
    registryFor: async () => new Set()
  });
  const acc = auditLib.mergeChunk(null, chunk);
  const dup = auditLib.duplicateSummary(acc);
  assert.strictEqual(dup.crosspostHashes, 0);
  assert.strictEqual(dup.repostHashes, 0);
});

test('mergeChunk caps tracked hashes at MAX_TRACKED_HASHES and reports the cap explicitly, never silently', () => {
  const hits = Array.from({ length: auditLib.MAX_TRACKED_HASHES + 50 }, (_, i) => ({
    hash: `hash${i}`, sub: 'writing', rowKey: `r${i}`, permalink: null
  }));
  const acc = auditLib.mergeChunk(null, {
    rowsScanned: hits.length, missingBlobs: 0, quoteCounts: {}, quoteSamples: {}, hashHits: hits,
    emptyRemoved: {}, bodyLength: {}, nonEnglish: {}
  });
  assert.strictEqual(acc.trackedHashCount, auditLib.MAX_TRACKED_HASHES);
  assert.strictEqual(acc.hashCapHit, true, 'exceeding the cap must be reported, not silently dropped');
});

// ---------------------------------------------------------------------------
// §8f — concentration of AI-related content by sub / enclave (REQUIRED fixture per §9)
// ---------------------------------------------------------------------------

test('§8f: a fixture where AI-related content concentrates in an enclave sub shows a large enclaveShare', () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ({ partitionKey: 'ai-writers-enclave', analyzed: true, aiRelated: true, rowKey: `e${i}` })),
    ...Array.from({ length: 10 }, (_, i) => ({ partitionKey: 'writing', analyzed: true, aiRelated: true, rowKey: `p${i}` }))
  ];
  const { subConcentration } = auditLib.tableChecks(rows, { subTags: { 'ai-writers-enclave': 'enclave', writing: 'population' } });
  assert.strictEqual(subConcentration.totalAiRelated, 40);
  assert.strictEqual(subConcentration.enclaveShare, 0.75);
  assert.strictEqual(subConcentration.populationShare, 0.25);
  assert.ok(subConcentration.enclaveShare > 0.5, 'the fixture must actually trip a large enclave share, or this check has never fired');
});

test('§8f: an evenly split fixture shows no enclave dominance (negative control)', () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => ({ partitionKey: 'enclave-sub', analyzed: true, aiRelated: true, rowKey: `e${i}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ partitionKey: 'pop-sub', analyzed: true, aiRelated: true, rowKey: `p${i}` }))
  ];
  const { subConcentration } = auditLib.tableChecks(rows, { subTags: { 'enclave-sub': 'enclave', 'pop-sub': 'population' } });
  assert.strictEqual(subConcentration.enclaveShare, 0.5);
});

// ---------------------------------------------------------------------------
// §8g — temporal concentration (REQUIRED fixture per §9)
// ---------------------------------------------------------------------------

test('§8g: a week engineered to exceed 3x the median is flagged as a spike', () => {
  const rows = [
    ...['2026-W10', '2026-W11', '2026-W12', '2026-W13'].flatMap((week) =>
      Array.from({ length: 5 }, (_, i) => ({ partitionKey: 'writing', analyzed: true, aiRelated: true, week, rowKey: `${week}-${i}` }))),
    // a news-event spike: 25 rows in one week vs a median of 5 (5x)
    ...Array.from({ length: 25 }, (_, i) => ({ partitionKey: 'writing', analyzed: true, aiRelated: true, week: '2026-W14', rowKey: `spike${i}` }))
  ];
  const { temporal } = auditLib.tableChecks(rows);
  assert.strictEqual(temporal.median, 5);
  const spikeWeeks = temporal.spikes.map((s) => s.week);
  assert.ok(spikeWeeks.includes('2026-W14'), `expected 2026-W14 flagged as a spike, got: ${JSON.stringify(temporal.spikes)}`);
  assert.strictEqual(temporal.spikes.find((s) => s.week === '2026-W14').count, 25);
});

test('§8g: an evenly distributed fixture flags no spikes (negative control)', () => {
  const rows = ['2026-W10', '2026-W11', '2026-W12', '2026-W13'].flatMap((week) =>
    Array.from({ length: 5 }, (_, i) => ({ partitionKey: 'writing', analyzed: true, aiRelated: true, week, rowKey: `${week}-${i}` })));
  const { temporal } = auditLib.tableChecks(rows);
  assert.strictEqual(temporal.spikes.length, 0);
});

test('§8g: pre-2019 rows are reported as strays, not silently folded into the timeline', () => {
  const rows = [
    { partitionKey: 'writing', analyzed: true, aiRelated: true, week: '2018-W42', rowKey: 's1' },
    { partitionKey: 'writing', analyzed: true, aiRelated: true, week: '2026-W10', rowKey: 'n1' }
  ];
  const { temporal } = auditLib.tableChecks(rows);
  assert.deepStrictEqual(temporal.strayWeeks, [{ week: '2018-W42', count: 1 }]);
});

// ---------------------------------------------------------------------------
// §8d, §8h, §8i, §8e, §8j — direct coverage (not required to be fixture-engineered
// by §9, but tested against both a tripping and a clean case regardless)
// ---------------------------------------------------------------------------

test('§8d: [removed], [deleted], empty, and under-threshold bodies all count as empty-or-removed', () => {
  for (const body of ['[removed]', '[deleted]', '', '   ', 'short']) {
    assert.strictEqual(auditLib.isEmptyOrRemoved(body), true, `"${body}" must count as empty/removed`);
  }
  assert.strictEqual(auditLib.isEmptyOrRemoved('A genuine post body long enough to clear the minimum length floor easily.'), false);
});

test('§8h: a strong stance with aiRelated false, and aiRelated true with no stance, are both flagged', () => {
  const rows = [
    { partitionKey: 'writing', analyzed: true, aiRelated: false, stance: 'hostile', rowKey: 'a' },
    { partitionKey: 'writing', analyzed: true, aiRelated: true, stance: 'na', rowKey: 'b' },
    { partitionKey: 'writing', analyzed: true, aiRelated: true, stance: 'curious', rowKey: 'c' } // coherent — not flagged
  ];
  const { stanceCoherence } = auditLib.tableChecks(rows);
  assert.strictEqual(stanceCoherence.strongStanceNotAiRelated, 1);
  assert.strictEqual(stanceCoherence.aiRelatedNoStance, 1);
});

test('§8i: a sub with zero bot/boilerplate detections across real rows is listed as a red flag, not silently clean', () => {
  const rows = [
    { partitionKey: 'suspiciously-clean-sub', contentClass: 'human', rowKey: 'a' },
    { partitionKey: 'suspiciously-clean-sub', contentClass: 'human', rowKey: 'b' },
    { partitionKey: 'normal-sub', contentClass: 'bot', contentClassReason: 'automod-author', rowKey: 'c' }
  ];
  const { botDetectionCoverage } = auditLib.tableChecks(rows);
  assert.ok(botDetectionCoverage.zeroDetectionSubs.includes('suspiciously-clean-sub'));
  assert.ok(!botDetectionCoverage.zeroDetectionSubs.includes('normal-sub'));
});

test('§8e: a critique-flaired row in a fiction-heavy sub is sampled with its permalink and stance', () => {
  const rows = [
    { partitionKey: 'destructivereaders', analyzed: true, flair: 'Critique', permalink: '/r/destructivereaders/x/', stance: 'na', rowKey: 'a' },
    { partitionKey: 'writing', analyzed: true, flair: 'Question', permalink: '/r/writing/y/', stance: 'curious', rowKey: 'b' }
  ];
  const { fictionSample, flairBySub } = auditLib.tableChecks(rows);
  assert.strictEqual(fictionSample.length, 2, 'destructivereaders is fiction-heavy by name; writing is caught by fiction-heavy-sub membership too');
  assert.deepStrictEqual(flairBySub.destructivereaders, { Critique: 1 });
});

test('§8j: text with almost no common English stopwords is flagged as possibly non-English', () => {
  const nonEnglishLike = 'Bonjour tout le monde je voudrais partager mon roman avec vous aujourd hui car il est enfin termine.';
  assert.strictEqual(auditLib.looksNonEnglish(nonEnglishLike), true);
});

test('§8j: ordinary English prose is not flagged (negative control)', () => {
  const english = 'I have been working on this draft for a while and would love some feedback on the pacing of the third act.';
  assert.strictEqual(auditLib.looksNonEnglish(english), false);
});

test('§8j: short text is not judged either way', () => {
  assert.strictEqual(auditLib.looksNonEnglish('ok thanks'), false);
});

// ---------------------------------------------------------------------------
// §8m — the audit worker itself: resumable, persists progress, self-requeues
// ---------------------------------------------------------------------------

// The 'audit'/'latest' REPORT (health-facing) still goes through the real
// Table-storage path (saveAggregate → tablesafe.packJson), so this routes
// THROUGH tablesafe for real — a plain in-memory Map here is exactly the gap
// that let the r2 incident ship undetected (a fake that never truncates can
// never catch a bug that only manifests under Table's size ceiling).
function fakeAuditStore({ rows = [], analyzedRows = [], getRaw } = {}) {
  const saved = new Map();
  const blobs = new Map();
  return {
    saved,
    blobs,
    ensureInfra: async () => {},
    listRowsForAudit: async () => rows,
    listAnalyzedPosts: async () => analyzedRows,
    getAggregate: async (p, k) => {
      const row = saved.get(`${p}|${k}`);
      if (!row) return null;
      const r = tablesafe.unpackJson(row);
      return r.ok ? r.value : { error: r.error };
    },
    saveAggregate: async (p, k, v) => {
      const { props } = tablesafe.packJson(v);
      saved.set(`${p}|${k}`, props);
    },
    // Real serialization boundary: a blob is a STRING on the wire. No
    // shrinkToFit, no size ceiling in this fake either — matching real Blob
    // Storage, which is the whole point of the r2 fix.
    getBlobJson: async (name) => {
      if (!blobs.has(name)) return null;
      try { return JSON.parse(blobs.get(name)); } catch (e) { return { __corrupt: true, error: e.message }; }
    },
    saveBlobJson: async (name, value) => { blobs.set(name, JSON.stringify(value)); },
    getRaw: getRaw || (async () => ({ post: { title: '', selftext: '' }, comments: [] }))
  };
}
const fakeRegistry = { load: async () => new Set() };

test('§8m: runAuditChunk persists a report via saveAggregate BEFORE returning, and marks exhausted correctly on a small corpus', async () => {
  const storeImpl = fakeAuditStore({
    rows: [{ partitionKey: 'writing', author: 'a', analyzed: true, aiRelated: true, stance: 'curious', week: '2026-W10', rowKey: 'x' }],
    analyzedRows: [{ partitionKey: 'writing', rowKey: 'x', createdUtc: 1_760_000_000, analysisJson: '{}' }]
  });
  const result = await runAuditChunk({ chunkSize: 2000 }, noopContext, { storeImpl, registryImpl: fakeRegistry });

  assert.strictEqual(result.capped, false, 'a corpus of 1 row must fully exhaust in a single chunk');
  assert.ok(storeImpl.saved.has('audit|latest'), 'the report must be persisted to aggregates before the worker returns');
  const persisted = await storeImpl.getAggregate('audit', 'latest'); // real read path, through tablesafe.unpackJson
  assert.strictEqual(persisted.exhausted, true);
  assert.strictEqual(persisted.authorConcentration.totalAuthors, 1, 'table-only checks must be present in the persisted report');
});

test('§9: the audit is zero-model-call — a spy store never sees enqueueAnalysis or any AOAI entry point', async () => {
  const calls = { enqueueAnalysis: 0 };
  const storeImpl = fakeAuditStore({
    rows: [{ partitionKey: 'writing', author: 'a', analyzed: true, aiRelated: true, stance: 'curious', week: '2026-W10', rowKey: 'x' }],
    analyzedRows: [{ partitionKey: 'writing', rowKey: 'x', createdUtc: 1_760_000_000, analysisJson: '{}' }]
  });
  storeImpl.enqueueAnalysis = async () => { calls.enqueueAnalysis++; };
  await runAuditChunk({ chunkSize: 2000 }, noopContext, { storeImpl, registryImpl: fakeRegistry });
  assert.strictEqual(calls.enqueueAnalysis, 0, 'the audit must never enqueue analysis — it is read-only by construction');

  const fs = require('node:fs');
  for (const mod of ['../src/lib/audit.js', '../src/lib/audit-worker.js', '../src/functions/audit.js']) {
    const src = fs.readFileSync(require.resolve(mod), 'utf8');
    assert.ok(!src.includes("require('./aoai')") && !src.includes("require('../lib/aoai')"),
      `${mod} must not import the AOAI client module at all — zero model calls is structural, not just untriggered`);
  }
});

test('§8m: runAuditChunk reports capped:false→true resumability and advances the cursor across two chunks', async () => {
  const analyzedRows = Array.from({ length: 3 }, (_, i) => ({
    partitionKey: 'writing', rowKey: `r${i}`, createdUtc: 1_760_000_000 + i, analysisJson: '{}'
  }));
  const storeImpl = fakeAuditStore({ rows: [], analyzedRows });

  const first = await runAuditChunk({ chunkSize: 1 }, noopContext, { storeImpl, registryImpl: fakeRegistry });
  assert.strictEqual(first.capped, true, 'limit=1 against 3 rows must cap the first chunk');
  assert.strictEqual(first.resumeAfter, 'writing|r0');
  const afterFirst = await storeImpl.getAggregate('audit', 'latest');
  assert.strictEqual(afterFirst.rowsScannedSoFar, 1, 'cumulative progress after chunk 1');

  const second = await runAuditChunk({ chunkSize: 1, after: first.resumeAfter }, noopContext, { storeImpl, registryImpl: fakeRegistry });
  const afterSecond = await storeImpl.getAggregate('audit', 'latest');
  assert.strictEqual(afterSecond.rowsScannedSoFar, 2, 'progress must ACCUMULATE across chunks, not reset — this is what "partial results" in §8m means');
  assert.notStrictEqual(afterSecond.rowsScannedSoFar, second.rowsThisChunk,
    'a report reflecting only the latest chunk (not the merged total) would silently under-report almost the whole corpus');
});

// ---------------------------------------------------------------------------
// r2 — live incident, 2026-08-16 20:49Z: auditWorker poisoned forever after
// chunk 1. Root cause: the accumulator's `hashes` field was silently dropped
// by saveAggregate/shrinkToFit once the accumulator exceeded Table Storage's
// 32,768-char property ceiling (measured live: stuck at rowsScannedSoFar=4000
// for 2h14m, audit-jobs-poison had messages). The next chunk's
// mergeChunk(prevAcc, chunk) then threw on `next.hashes[hit.hash]` against an
// `undefined` field, and poisoned after 5 retries.
// ---------------------------------------------------------------------------

test('r2 (a): a realistic-volume accumulator must survive a save+reload cycle without losing `hashes` — reproduces the live truncation', async () => {
  // Mirrors the live incident almost exactly: chunkSize=4000 caps the first
  // chunk at 4000 rows (the live value), each with a distinct eligible body
  // so `hashes` alone grows to ~4000 entries — comfortably past Table
  // Storage's 360,000-char accumulator ceiling.
  const N = 4001;
  const analyzedRows = Array.from({ length: N }, (_, i) => ({
    partitionKey: 'writing', rowKey: `r${i}`, createdUtc: 1_760_000_000 + i, analysisJson: '{}'
  }));
  const bodies = Array.from({ length: N }, (_, i) => `${'x'.repeat(150)}_${i}`); // each normalises to a distinct eligible hash
  const storeImpl = fakeAuditStore({
    rows: [],
    analyzedRows,
    getRaw: async (sub, utc, id) => ({ post: { title: '', selftext: bodies[Number(id.slice(1))] }, comments: [] })
  });

  const first = await runAuditChunk({ chunkSize: 4000 }, noopContext, { storeImpl, registryImpl: fakeRegistry });
  assert.strictEqual(first.capped, true, 'chunkSize=4000 against 4001 rows must cap the first chunk, exactly like the live incident');
  assert.strictEqual(first.rowsThisChunk, 4000);

  // The second chunk reloads chunk 1's persisted accumulator and merges into
  // it. At 2f9bb00 this throws (hashes silently dropped on save, then
  // `next.hashes[hit.hash]` on `undefined` on reload) — this IS the live
  // crash, reproduced here without any Azure dependency.
  const second = await runAuditChunk({ chunkSize: 4000, after: first.resumeAfter }, noopContext, { storeImpl, registryImpl: fakeRegistry });
  assert.strictEqual(second.capped, false, 'the remaining 1 row must exhaust the corpus');
  assert.strictEqual(second.report.rowsScannedSoFar, N);
  assert.strictEqual(second.report.duplicates.trackedHashCount, N, 'every one of the 4,001 distinct hashes must survive the round trip — none silently dropped');
});

test('r2 (4): mergeChunk REJECTS a prevAcc missing required fields rather than proceeding', () => {
  // Exactly the live-incident shape: `hashes` (and other fields) missing.
  const truncatedAcc = { rowsScanned: 4000, missingBlobs: 0, quoteCounts: {}, quoteSamples: {} };
  const chunk = {
    rowsScanned: 1, missingBlobs: 0, quoteCounts: {}, quoteSamples: {},
    hashHits: [{ hash: 'x', sub: 'writing', rowKey: 'r', permalink: null }],
    emptyRemoved: {}, bodyLength: {}, nonEnglish: {}, capped: false, resumeAfter: 'writing|r'
  };
  assert.throws(() => auditLib.mergeChunk(truncatedAcc, chunk), auditLib.AccumulatorShapeError);
  try {
    auditLib.mergeChunk(truncatedAcc, chunk);
    assert.fail('must have thrown');
  } catch (e) {
    assert.ok(e instanceof auditLib.AccumulatorShapeError);
    assert.ok(e.missing.includes('hashes'), `expected 'hashes' named as missing, got: ${JSON.stringify(e.missing)}`);
  }
});

test('r2 (5): the worker detects an invalid accumulator and restarts the pass cleanly instead of crashing', async () => {
  const analyzedRows = [
    { partitionKey: 'writing', rowKey: 'a', createdUtc: 1_760_000_000, analysisJson: '{}' },
    { partitionKey: 'writing', rowKey: 'b', createdUtc: 1_760_000_001, analysisJson: '{}' }
  ];
  const storeImpl = fakeAuditStore({ rows: [], analyzedRows });
  // A truncated accumulator already sitting in the blob location — simulates
  // upgrading straight into the live-incident state.
  storeImpl.blobs.set(ACCUMULATOR_NAME, JSON.stringify({
    rowsScanned: 4000, missingBlobs: 0, quoteCounts: {}, quoteSamples: {},
    hashCapHit: false, trackedHashCount: 4000, emptyRemoved: {}, bodyLength: {}, nonEnglish: {},
    cursor: 'writing|zzz'
  })); // missing `hashes`

  const result = await runAuditChunk({ chunkSize: 10, after: 'writing|zzz' }, noopContext, { storeImpl, registryImpl: fakeRegistry });
  assert.strictEqual(result.restarted, true, 'an invalid accumulator must be detected and reported as a restart, not silently patched or left to throw');
  assert.strictEqual(result.report.rowsScannedSoFar, 2, 'a restart re-scans from the beginning — both rows, not a continuation from the stale cursor');
});

test('r2: a corrupt (unparseable) accumulator blob also triggers a clean restart, not a crash', async () => {
  const analyzedRows = [{ partitionKey: 'writing', rowKey: 'a', createdUtc: 1_760_000_000, analysisJson: '{}' }];
  const storeImpl = fakeAuditStore({ rows: [], analyzedRows });
  storeImpl.blobs.set(ACCUMULATOR_NAME, '{not valid json');

  const result = await runAuditChunk({ chunkSize: 10, after: 'writing|zzz' }, noopContext, { storeImpl, registryImpl: fakeRegistry });
  assert.strictEqual(result.restarted, true);
  assert.strictEqual(result.report.rowsScannedSoFar, 1);
});

test('r2 (1): quoteSamples is reservoir-sampled per (subreddit, bucket), capped, and the true `seen` count is never hidden', () => {
  let acc = null;
  const cap = auditLib.QUOTE_SAMPLE_CAP_PER_PARTITION;
  const N = cap * 20; // far more items offered than the cap
  for (let i = 0; i < N; i++) {
    const chunk = {
      rowsScanned: 1, missingBlobs: 0,
      quoteCounts: {}, quoteSamples: { writing: { 'not-found': [{ subreddit: 'writing', permalink: `/p/${i}`, quote: `q${i}` }] } },
      hashHits: [], emptyRemoved: {}, bodyLength: {}, nonEnglish: {}, capped: i < N - 1, resumeAfter: `writing|${i}`
    };
    acc = auditLib.mergeChunk(acc, chunk);
  }
  const bucket = acc.quoteSamples.writing['not-found'];
  assert.strictEqual(bucket.seen, N, 'the true seen count must be visible in the output, not just the capped sample size — no silent caps');
  assert.strictEqual(bucket.items.length, cap, `must never exceed the per-partition cap of ${cap}`);
});

test('r2 (2)/(b): a 3+ chunk pass through the REAL queue-message serialization boundary advances rowsScannedSoFar monotonically and drops nothing', async () => {
  const N = 7;
  const analyzedRows = Array.from({ length: N }, (_, i) => ({
    partitionKey: 'writing', rowKey: `q${i}`, createdUtc: 1_760_000_000 + i, analysisJson: '{}'
  }));
  const bodies = Array.from({ length: N }, (_, i) => `${'y'.repeat(150)}_${i}`);
  const storeImpl = fakeAuditStore({
    rows: [],
    analyzedRows,
    getRaw: async (sub, utc, id) => ({ post: { title: '', selftext: bodies[Number(id.slice(1))] }, comments: [] })
  });

  // Mirrors store.enqueueAudit / the storageQueue trigger's own decode
  // exactly: base64 on the way in, JSON.parse on the way out. The prior
  // version of this test called runAuditChunk directly with a fake store and
  // never crossed this boundary at all — which is exactly why the r2 defect
  // shipped undetected.
  const enqueue = (job) => Buffer.from(JSON.stringify(job)).toString('base64');
  const dequeue = (b64) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

  let job = { chunkSize: 2 };
  const seen = [];
  for (let i = 0; i < 10; i++) { // generous upper bound; loop exits once exhausted
    const decoded = dequeue(enqueue(job));
    const result = await runAuditChunk(decoded, noopContext, { storeImpl, registryImpl: fakeRegistry });
    seen.push(result.report.rowsScannedSoFar);
    if (!result.capped) break;
    job = { after: result.resumeAfter, chunkSize: 2 };
  }

  assert.ok(seen.length >= 3, `expected at least 3 chunks for ${N} rows at chunkSize=2, got ${seen.length}`);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] > seen[i - 1], `rowsScannedSoFar must advance monotonically: ${JSON.stringify(seen)}`);
  }
  assert.strictEqual(seen[seen.length - 1], N, 'the final chunk must reflect the WHOLE corpus, not just its own window');

  const finalAcc = await storeImpl.getBlobJson(ACCUMULATOR_NAME);
  assert.strictEqual(finalAcc.trackedHashCount, N, 'no hash may be dropped across the multi-chunk pass');
  auditLib.validateAccumulator(finalAcc); // must still be a well-formed accumulator after N chunks
});

test('r2 (3)/(c): no silent caps — every bound applied is visible in the report output, not just internal state', async () => {
  const analyzedRows = [{ partitionKey: 'writing', rowKey: 'a', createdUtc: 1_760_000_000, analysisJson: '{}' }];
  const storeImpl = fakeAuditStore({ rows: [], analyzedRows });
  const { report } = await runAuditChunk({ chunkSize: 10 }, noopContext, { storeImpl, registryImpl: fakeRegistry });

  assert.strictEqual(report.quoteProvenance.sampleCapPerPartition, auditLib.QUOTE_SAMPLE_CAP_PER_PARTITION,
    'the quote-sample cap must be a named field in the report, not something a reader has to infer');
  assert.strictEqual(report.duplicates.maxTrackedHashes, auditLib.MAX_TRACKED_HASHES,
    'the duplicate-hash cap must be a named field in the report, not something a reader has to infer');
  assert.ok('hashCapHit' in report.duplicates && 'trackedHashCount' in report.duplicates);
});
