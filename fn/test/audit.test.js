'use strict';

// CB-LISTEN-REPO-6 §8 (adopted verbatim by CB-LISTEN-REPO-7 §1) — the corpus
// quality audit. §9 names five checks that MUST be verified against a fixture
// engineered to trip them, not merely against real data that may happen to be
// clean: §8a, §8b, §8c, §8f, §8g. Those five get dedicated fixture tests
// below; §8d/§8e/§8h/§8i/§8j get direct coverage too, at lighter depth.

const test = require('node:test');
const assert = require('node:assert');

const auditLib = require('../src/lib/audit');
const { runAuditChunk } = require('../src/lib/audit-worker');

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
  assert.strictEqual(chunk.quoteSamples['bot-comment'].length, 1);
  assert.strictEqual(chunk.quoteSamples['not-found'].length, 1);
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

function fakeAuditStore({ rows = [], analyzedRows = [], getRaw } = {}) {
  const saved = new Map();
  return {
    saved,
    ensureInfra: async () => {},
    listRowsForAudit: async () => rows,
    listAnalyzedPosts: async () => analyzedRows,
    getAggregate: async (p, k) => saved.get(`${p}|${k}`) || null,
    saveAggregate: async (p, k, v) => { saved.set(`${p}|${k}`, v); },
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
  const persisted = storeImpl.saved.get('audit|latest');
  assert.strictEqual(persisted.exhausted, true);
  assert.strictEqual(persisted.authorConcentration.totalAuthors, 1, 'table-only checks must be present in the persisted report');
});

test('§8m: runAuditChunk reports capped:false→true resumability and advances the cursor across two chunks', async () => {
  const analyzedRows = Array.from({ length: 3 }, (_, i) => ({
    partitionKey: 'writing', rowKey: `r${i}`, createdUtc: 1_760_000_000 + i, analysisJson: '{}'
  }));
  const storeImpl = fakeAuditStore({ rows: [], analyzedRows });

  const first = await runAuditChunk({ chunkSize: 1 }, noopContext, { storeImpl, registryImpl: fakeRegistry });
  assert.strictEqual(first.capped, true, 'limit=1 against 3 rows must cap the first chunk');
  assert.strictEqual(first.resumeAfter, 'writing|r0');
  const afterFirst = storeImpl.saved.get('audit|latest');
  assert.strictEqual(afterFirst.rowsScannedSoFar, 1, 'cumulative progress after chunk 1');

  const second = await runAuditChunk({ chunkSize: 1, after: first.resumeAfter }, noopContext, { storeImpl, registryImpl: fakeRegistry });
  const afterSecond = storeImpl.saved.get('audit|latest');
  assert.strictEqual(afterSecond.rowsScannedSoFar, 2, 'progress must ACCUMULATE across chunks, not reset — this is what "partial results" in §8m means');
  assert.notStrictEqual(afterSecond.rowsScannedSoFar, second.rowsThisChunk,
    'a report reflecting only the latest chunk (not the merged total) would silently under-report almost the whole corpus');
});
