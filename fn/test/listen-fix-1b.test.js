'use strict';

// CB-LISTEN-FIX-1b corrective round: basis-split feature board (R1), replay
// path through the shipped filter + validator (R2), truncation-aware grounding
// (R3), audit quote coverage for v4 fields (R4), comment role capture at
// ingest (R5).
//
// ALL TEXT HERE IS INVENTED — no real usernames, no subreddit text. Ingest
// tests stub globalThis.fetch; nothing leaves the process.

const test = require('node:test');
const assert = require('node:assert');

const { runRollup } = require('../src/lib/rollup-engine');
const { replayRow } = require('../scripts/quality-pilot');
const { checkQuotes, analysisQuotes } = require('../src/lib/quality-benchmark');
const { validateAnalysis } = require('../src/lib/grounding-validator');
// Loaded tolerantly so the file runs against the predecessor SHAs (where this
// module does not exist) and each test fails on its own assertion.
const { promptView = () => { throw new Error('prompt-view absent'); } } =
  (() => { try { return require('../src/lib/prompt-view'); } catch { return {}; } })();
const { analyzePost } = require('../src/lib/aoai');
const { quoteFieldsOf } = require('../src/lib/audit');
const { quotesFrom } = require('../src/lib/retag');
const { filterContributions } = require('../src/lib/contribution-filter');

const MOD_NOTE = 'Your submission has been removed because generated drafts are not permitted in this community under rule four.';
const HUMAN_A = 'I keep my outline in a spreadsheet so I can see every subplot at once.';
const HUMAN_B = 'My critique partners mark up a printed copy and that works better than any app I tried.';
const POST = {
  subreddit: 'examplewriters', title: 'How do you all track revisions?',
  selftext: 'I am on my third revision and I lose track of which scenes I already fixed.',
  author: 'fixture_op', created_utc: 1_760_000_000, kind: 'post', source: 'reddit'
};

const emptyOutput = () => ({
  ai_related: false, stance_on_ai: 'na',
  persona: { experience: 'unknown', goal: '', goal_quote: '', goal_speaker: '' },
  stance_basis: [], stance_intensity: 0,
  comment_stance_mix: { hostile: 0, wary: 0, conflicted: 0, curious: 0, pragmatic: 0, enthusiastic: 0 },
  topics: [], pain_points: [], expected_baseline: [], deal_breakers: [], trust_signals: [],
  feature_requests: [], ethics_concerns: [], tools_mentioned: [],
  notable_quote: '', notable_quote_speaker: '', summary: ''
});

// ---- R1 --------------------------------------------------------------------

function rollupRow(i, features) {
  return {
    partitionKey: 'examplewriters', rowKey: `r${i}`, source: 'reddit', title: `post ${i}`, author: `fixture_${i}`,
    permalink: `/r/examplewriters/r${i}`, score: 1, createdUtc: 1_760_000_000 + i,
    analysisJson: JSON.stringify({ ...emptyOutput(), ai_related: true, stance_on_ai: 'curious', feature_requests: features })
  };
}

test('R1: the feature board reports basis separately; existing usage is counted, never ranked; legacy is labelled, never guessed', async () => {
  const f = (feature, basis) => ({ feature, ai_related: false, quote: 'q', speaker: 'post', ...(basis ? { basis } : {}) });
  const rows = [
    rollupRow(1, [f('outline view')]),                              // v3: no basis
    rollupRow(2, [f('outline view'), f('word targets')]),           // v3
    rollupRow(3, [f('outline view', 'explicit_request'), f('scene cards', 'existing_usage')]),
    rollupRow(4, [f('outline view', 'implied_need'), f('scene cards', 'existing_usage'), f('word targets', 'explicit_request')])
  ];
  const saved = new Map();
  const store = {
    listAnalyzedPosts: async () => rows,
    saveAggregate: async (p, k, v) => { saved.set(p, v); },
    getAggregate: async (p) => saved.get(p) || null
  };
  const aoai = {
    normalizeFeatures: async (names) => ({ groups: names.map((n, i) => ({ canonical: n, members: [i] })) }),
    synthesizePersonas: async () => ({ personas: [] }),
    strategyBrief: async () => ({ answers: [] }),
    standingQuestions: () => []
  };
  await runRollup({ store, aoai, context: { log() {}, warn() {}, error() {} },
    env: { SUBREDDITS: 'examplewriters', SUB_TAGS: '{}' }, now: () => new Date('2026-09-25T00:00:00Z') });
  const features = saved.get('features');
  assert.deepStrictEqual(features.basisCounts, { explicit_request: 2, implied_need: 1, existing_usage: 2, legacy: 3 });
  assert.deepStrictEqual(features.existingUsage, { count: 2 });
  assert.strictEqual(features.totalNames, 6, 'only non-existing-usage mentions are ranked');
  const byBasis = {};
  for (const entry of features.featureBoard) {
    for (const [b, n] of Object.entries(entry.byBasis)) byBasis[b] = (byBasis[b] || 0) + n;
  }
  assert.deepStrictEqual(byBasis, { legacy: 3, explicit_request: 2, implied_need: 1 });
  assert.ok(!features.featureBoard.some((e) => e.feature === 'scene cards'), 'existing usage must not be ranked on the board');
});

// ---- R2 --------------------------------------------------------------------

test('R2: the metered replay path never sends a ModTeam comment, and its stored result carries grounding counts', async () => {
  const raw = { post: POST, comments: [
    { author: 'fixture_a', body: HUMAN_A },
    { author: 'examplewriters-ModTeam', distinguished: null, body: MOD_NOTE },
    { author: 'fixture_b', body: HUMAN_B }
  ] };
  const row = { partitionKey: 'examplewriters', rowKey: 'p1', analysisJson: JSON.stringify(emptyOutput()) };
  const shown = [];
  let reserved = 0;
  const result = await replayRow(row, raw, {
    registry: new Set(),
    reserve: async () => { reserved++; return true; },
    checkQuotes,
    analyzePost: async (post, comments) => {
      shown.push(...comments.map((c) => c.body));
      const out = emptyOutput();
      out.pain_points = [
        { item: 'rule four removals', quote: 'not permitted in this community', speaker: 'comment 1' },
        { item: 'paper markup', quote: 'mark up a printed copy', speaker: 'comment 2' }
      ];
      return { ...out, _provenance: { analysisInputHash: 'x' } };
    }
  });
  assert.strictEqual(reserved, 1);
  assert.deepStrictEqual(shown, [HUMAN_A, HUMAN_B], 'the ModTeam comment must never reach the model');
  assert.deepStrictEqual(result.filteredComments, { 'role-mod-team-account': 1 });
  assert.ok(result.analysis.grounding, 'stored replay result must carry grounding counts');
  assert.deepStrictEqual(result.analysis.grounding.drops, { pain_points: 1 });
  assert.deepStrictEqual(result.analysis.pain_points.map((p) => p.item), ['paper markup']);
  assert.ok(!('_provenance' in result.analysis));
});

test('R2: the replay path does not analyse, or reserve a cap slot for, an excluded submission', async () => {
  const raw = { post: { ...POST, author: 'AutoModerator' }, comments: [{ author: 'fixture_a', body: HUMAN_A }] };
  let reserved = 0, called = 0;
  const result = await replayRow({ analysisJson: '{}' }, raw, {
    registry: new Set(), checkQuotes,
    reserve: async () => { reserved++; return true; },
    analyzePost: async () => { called++; return emptyOutput(); }
  });
  assert.strictEqual(result.skipped, 'excluded-post:automod-author');
  assert.strictEqual(reserved, 0);
  assert.strictEqual(called, 0);
});

// ---- R3 --------------------------------------------------------------------

test('R3: a quote located after the 8,000-character comment cut is rejected; one before it is kept', () => {
  const filler = 'the draft keeps growing and the notes pile up. '.repeat(200); // ~9,400 chars
  const early = 'my index cards live in a shoebox';
  const late = 'the timeline spreadsheet finally saved me';
  const long = `${early} ${filler.slice(0, 8200)} ${late} ${filler.slice(0, 500)}`;
  const comments = [{ body: HUMAN_A }, { body: long }];
  assert.ok(!promptView(POST, comments).commentBlock.includes(late), 'fixture must put the late quote past the cut');
  const item = (quote) => ({ item: 'x', quote, speaker: 'comment 2' });
  const { analysis, dropReasons } = validateAnalysis({ pain_points: [item(early), item(late)] }, { post: POST, comments });
  assert.deepStrictEqual(analysis.pain_points.map((p) => p.quote), [early]);
  assert.strictEqual(dropReasons['pain_points:quote-not-in-unit'], 1);
});

test('R3: a quote after the 6,000-character post-body cut is rejected, and the prompt is built from the same view', async () => {
  const late = 'which is why I switched to paper outlines';
  const post = { ...POST, selftext: `${'I revise every morning before work. '.repeat(180)} ${late}` }; // >6,000 chars
  const { drops } = validateAnalysis({ pain_points: [{ item: 'x', quote: late, speaker: 'post' }] }, { post, comments: [] });
  assert.strictEqual(drops.pain_points, 1);
  let prompt = '';
  await analyzePost(post, [{ body: HUMAN_A }], { chat: async (s, u) => { prompt = u; return emptyOutput(); } });
  const view = promptView(post, [{ body: HUMAN_A }]);
  assert.ok(prompt.includes(view.body) && prompt.includes(view.commentBlock));
  assert.ok(!prompt.includes(late));
});

// ---- R4 --------------------------------------------------------------------

const V4_QUOTES = {
  pain: 'losing track of which scenes I already fixed',
  baseline: 'every editor I have used saves versions automatically',
  ethics: 'nobody asked us before scraping our stories for training',
  tool: 'the corkboard view in my outlining app is the only thing that works',
  goal: 'I want to finish this revision by the end of the month'
};
const v4Analysis = () => ({
  ...emptyOutput(),
  persona: { experience: 'unknown', goal: 'finish the revision', goal_quote: V4_QUOTES.goal, goal_speaker: 'post' },
  pain_points: [{ item: 'losing track of fixes', quote: V4_QUOTES.pain, speaker: 'post' }],
  expected_baseline: [{ item: 'automatic versions', quote: V4_QUOTES.baseline, speaker: 'comment 1' }],
  ethics_concerns: [{ item: 'training without consent', quote: V4_QUOTES.ethics, speaker: 'comment 1' }],
  tools_mentioned: [{ tool: 'outlining app', sentiment: 'positive', switching: false, context: 'corkboard view', quote: V4_QUOTES.tool, speaker: 'comment 1' }]
});

test('R4: analysisQuotes, quoteFieldsOf and quotesFrom cover every v4 quote field', () => {
  const a = v4Analysis();
  const expected = Object.values(V4_QUOTES).sort();
  assert.deepStrictEqual(analysisQuotes({ analysisJson: JSON.stringify(a) }).map((q) => q.quote).sort(), expected);
  assert.deepStrictEqual(quoteFieldsOf(a).map((q) => q.quote).sort(), expected);
  assert.deepStrictEqual(quotesFrom(a).sort(), expected);
  assert.deepStrictEqual(analysisQuotes({ analysisJson: JSON.stringify(a) }).map((q) => q.field).sort(),
    ['ethics_concerns', 'expected_baseline', 'pain_points', 'persona.goal', 'tools_mentioned']);
});

test('R4: source-confirmed contribution filtering removes a v4 item quoting only a ModTeam comment', () => {
  const analysis = { ...emptyOutput(),
    pain_points: [
      { item: 'rule four removals', quote: 'generated drafts are not permitted in this community', speaker: 'comment 1' },
      { item: 'outline in a spreadsheet', quote: 'outline in a spreadsheet so I can see', speaker: 'comment 2' }
    ] };
  const raw = { post: POST, comments: [{ author: 'examplewriters-ModTeam', body: MOD_NOTE }, { author: 'fixture_a', body: HUMAN_A }] };
  const row = { partitionKey: 'examplewriters', rowKey: 'p1', analysisJson: JSON.stringify(analysis) };
  const { row: out, audit } = filterContributions(row, raw, new Set());
  assert.deepStrictEqual(JSON.parse(out.analysisJson).pain_points.map((p) => p.item), ['outline in a spreadsheet']);
  assert.deepStrictEqual(audit.excluded.map((e) => [e.field, e.reasons]), [['pain_points', ['role-mod-team-account']]]);
});

// ---- R5 --------------------------------------------------------------------

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const json = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });

test('R5: Arctic Shift post comments keep distinguished and stickied', async () => {
  const arctic = require('../src/lib/sources/arcticshift');
  const comments = await withFetch(() => json({ data: [
    { id: 'c1', author: 'fixture_mod', body: 'Please keep feedback kind.', parent_id: 't3_p1', created_utc: 1, distinguished: 'moderator', stickied: true },
    { id: 'c2', author: 'fixture_a', body: HUMAN_A, parent_id: 't3_p1', created_utc: 2 }
  ] }), () => arctic.fetchPostComments('p1', 20));
  assert.deepStrictEqual(comments.map((c) => [c.distinguished, c.stickied]), [['moderator', true], [null, false]]);
});

test('R5: Reddit OAuth top comments keep distinguished and stickied', async () => {
  const saved = { id: process.env.REDDIT_CLIENT_ID, secret: process.env.REDDIT_CLIENT_SECRET };
  process.env.REDDIT_CLIENT_ID = 'fixture-id';
  process.env.REDDIT_CLIENT_SECRET = 'fixture-secret';
  try {
    const reddit = require('../src/lib/reddit');
    const comments = await withFetch((url) => url.includes('access_token')
      ? json({ access_token: 'fixture-token', expires_in: 3600 })
      : json([{}, { data: { children: [
        { kind: 't1', data: { id: 'c1', author: 'fixture_mod', score: 1, body: 'Thread locked.', distinguished: 'moderator', stickied: true } },
        { kind: 't1', data: { id: 'c2', author: 'fixture_a', score: 1, body: HUMAN_A, distinguished: null, stickied: false } }
      ] } }]), () => reddit.fetchTopComments('examplewriters', 'p1', 20));
    assert.deepStrictEqual(comments.map((c) => [c.distinguished, c.stickied]), [['moderator', true], [null, false]]);
  } finally {
    for (const [k, v] of [['REDDIT_CLIENT_ID', saved.id], ['REDDIT_CLIENT_SECRET', saved.secret]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
