'use strict';

// CB-LISTEN-FIX-1 regression tests: pre-model moderator/bot exclusion, grounded
// item schema, deterministic post-validator.
//
// ALL TEXT HERE IS INVENTED. The repo is public; these fixtures copy the
// structural shape of the defect (a mod-team note with distinguished: null, an
// AutoModerator welcome, a template pasted by an ordinary account) and none of
// the words. No real usernames, no subreddit text.
//
// The analyze path is exercised end to end through processAnalyzeJob with a
// spied chat client, so what the MODEL WAS SHOWN is asserted directly, and the
// fake model's output then goes through the real validator.

const test = require('node:test');
const assert = require('node:assert');

const { processAnalyzeJob } = require('../src/lib/analyze-worker');
const { filterComments, classifyComment, fingerprintsOf } = require('../src/lib/comment-filter');
// Loaded tolerantly so that, run against the baseline SHA (where this module
// does not exist), each test fails on its own assertion rather than the whole
// file failing to load.
const { validateAnalysis = () => { throw new Error('grounding-validator absent'); } } =
  (() => { try { return require('../src/lib/grounding-validator'); } catch { return {}; } })();
const { ANALYSIS_SCHEMA } = require('../src/lib/aoai');
const { parseRows } = require('../src/lib/rollup-engine');
const { FEATURE_BASIS } = require('../src/lib/taxonomy');

// ---- synthetic units -------------------------------------------------------

const MOD_NOTE = 'Your submission has been removed because generated drafts are not permitted in this community under rule four.';
const AUTOMOD_WELCOME = 'Welcome to the weekly check-in thread, please remember to be kind and keep feedback on topic.';
const TEMPLATE = 'Thanks for posting in the critique circle. Please remember to include your word count and genre. Posts without a sample are removed.';
const GENUINE_ADDITION = 'Honestly the pacing in chapter two dragged for me.';
const SHARED_OPINION = 'I stopped using the grammar plugin because it kept rewriting my dialogue into something flat and lifeless, and I could not switch that behaviour off.';
const HUMAN_A = 'I keep my outline in a spreadsheet so I can see every subplot at once.';
const HUMAN_B = 'My critique partners mark up a printed copy and that works better than any app I tried.';
const HUMAN_C = 'Automated writing just feels hollow to me, whatever the marketing says.';

const POST = {
  subreddit: 'examplewriters',
  title: 'How do you all track revisions?',
  selftext: 'I am on my third revision and I lose track of which scenes I already fixed.',
  author: 'fixture_op',
  created_utc: 1_760_000_000,
  kind: 'post',
  source: 'reddit'
};

const noopContext = { log() {}, warn() {}, error() {} };

function fakeRow() {
  let stored = { value: null, etag: null };
  return {
    async get() { return { value: stored.value, etag: stored.etag }; },
    async put(next, etag) {
      if (etag !== stored.etag) { const e = new Error('etag mismatch'); e.conflict = true; throw e; }
      stored = { value: next, etag: String(Number(stored.etag || 0) + 1) };
    }
  };
}

function fakeStore(raw) {
  const backends = new Map();
  const saved = [];
  return {
    saved,
    async getRaw() { return raw; },
    async getPostRow() { return null; },
    async enqueueAnalysis() {},
    async saveAnalysis(subreddit, id, analysis, meta) { saved.push({ analysis, meta }); },
    aggregateBackend(metric, period) {
      const key = `${metric}|${period}`;
      if (!backends.has(key)) backends.set(key, fakeRow());
      return backends.get(key);
    }
  };
}

const emptyOutput = () => ({
  ai_related: true, stance_on_ai: 'na',
  persona: { experience: 'unknown', goal: '', goal_quote: '', goal_speaker: '' },
  stance_basis: [], stance_intensity: 0,
  comment_stance_mix: { hostile: 0, wary: 0, conflicted: 0, curious: 0, pragmatic: 0, enthusiastic: 0 },
  topics: [], pain_points: [], expected_baseline: [], deal_breakers: [], trust_signals: [],
  feature_requests: [], ethics_concerns: [], tools_mentioned: [],
  notable_quote: '', notable_quote_speaker: '', summary: ''
});

// Run one post through the real analyze path. `respond(prompt)` builds the
// fake model's output from the prompt it was shown.
async function analyze(raw, respond = () => emptyOutput(), env = {}) {
  const saved = {};
  for (const k of ['DAILY_ANALYZE_CAP', ...Object.keys(env)]) saved[k] = process.env[k];
  process.env.DAILY_ANALYZE_CAP = '100';
  Object.assign(process.env, env);
  try {
    const store = fakeStore(raw);
    const prompts = [];
    const chat = async (system, user) => { prompts.push(user); return respond(user); };
    await processAnalyzeJob({ subreddit: raw.post.subreddit, id: 'p1', created_utc: raw.post.created_utc, kind: 'post' },
      noopContext, { storeImpl: store, chat, registryCache: { get: async () => new Set() } });
    return { prompts, saved: store.saved };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const commentLabels = (prompt) => (prompt.match(/\[comment \d+\]/g) || []).length;

// Every quote-bearing value the saved analysis attributes to any source.
function allQuotes(analysis) {
  const out = [];
  for (const [k, v] of Object.entries(analysis)) {
    if (Array.isArray(v)) for (const item of v) if (item && item.quote) out.push(item.quote);
    if (k === 'notable_quote' && v) out.push(v);
  }
  if (analysis.persona && analysis.persona.goal_quote) out.push(analysis.persona.goal_quote);
  return out;
}

// ---- T1 --------------------------------------------------------------------

test('T1: a mod-team-account unit with distinguished:null is excluded before the model and never sources a field', async () => {
  for (const modUnit of [
    { author: 'examplewriters-ModTeam', distinguished: null, body: MOD_NOTE },
    { author: 'fixture_speaker_9', distinguished: null, roleHint: 'mod-team-account', body: MOD_NOTE }
  ]) {
    assert.strictEqual(classifyComment(modUnit).reason, 'role-mod-team-account');
    const raw = { post: POST, comments: [{ author: 'fixture_a', body: HUMAN_A }, modUnit] };
    const { prompts, saved } = await analyze(raw, () => {
      // A model that attributes the mod note as writer pain, from either unit.
      const out = emptyOutput();
      out.pain_points = [
        { item: 'generated drafts banned', quote: 'generated drafts are not permitted', speaker: 'comment 1' },
        { item: 'generated drafts banned', quote: 'generated drafts are not permitted', speaker: 'post' },
        { item: 'generated drafts banned', quote: 'generated drafts are not permitted', speaker: 'comment 2' }
      ];
      out.feature_requests = [{ feature: 'rule reminders', ai_related: false, basis: 'explicit_request', quote: 'removed because generated drafts', speaker: 'comment 1' }];
      return out;
    });
    assert.strictEqual(prompts.length, 1);
    assert.ok(!prompts[0].includes('not permitted in this community'), 'mod note text reached the prompt');
    assert.strictEqual(commentLabels(prompts[0]), 1);
    const analysis = saved[0].analysis;
    assert.ok(allQuotes(analysis).every((q) => !MOD_NOTE.toLowerCase().includes(q.toLowerCase())),
      'an item sourced from the mod note survived');
    assert.strictEqual(analysis.grounding.drops.pain_points, 3);
    assert.strictEqual(analysis.grounding.drops.feature_requests, 1);
    assert.deepStrictEqual(saved[0].meta.botCommentsFilterReasons, { 'role-mod-team-account': 1 });
  }
});

// ---- T2 --------------------------------------------------------------------

test('T2: an automoderator unit is excluded the same way, by author or by roleHint', async () => {
  for (const botUnit of [
    { author: 'AutoModerator', distinguished: null, body: AUTOMOD_WELCOME },
    { author: 'fixture_speaker_7', distinguished: null, roleHint: 'automoderator', body: AUTOMOD_WELCOME }
  ]) {
    const raw = { post: POST, comments: [botUnit, { author: 'fixture_a', body: HUMAN_A }] };
    const { prompts, saved } = await analyze(raw, () => {
      const out = emptyOutput();
      out.expected_baseline = [{ item: 'kind feedback', quote: 'please remember to be kind', speaker: 'comment 1' }];
      return out;
    });
    assert.ok(!prompts[0].includes('weekly check-in thread'), 'automoderator text reached the prompt');
    assert.strictEqual(commentLabels(prompts[0]), 1);
    assert.deepStrictEqual(saved[0].analysis.expected_baseline, []);
    assert.strictEqual(saved[0].analysis.grounding.dropReasons['expected_baseline:quote-not-in-unit'], 1);
  }
});

test('T2: an AutoModerator-authored submission is not sent to the model at all', async () => {
  const raw = { post: { ...POST, author: 'AutoModerator', selftext: AUTOMOD_WELCOME }, comments: [{ author: 'fixture_a', body: HUMAN_A }] };
  const { prompts, saved } = await analyze(raw);
  assert.strictEqual(prompts.length, 0);
  assert.strictEqual(saved.length, 0);
});

// ---- T3 --------------------------------------------------------------------

test('T3: a registered template posted by an ordinary account is excluded; with a genuine sentence added, only the template is removed', async () => {
  const env = { BOILERPLATE_FINGERPRINTS: fingerprintsOf(TEMPLATE).join(',') };
  const fingerprints = new Set(fingerprintsOf(TEMPLATE));
  assert.strictEqual(classifyComment({ author: 'fixture_b', body: TEMPLATE }, { fingerprints }).reason, 'boilerplate-fingerprint');

  const raw = { post: POST, comments: [
    { author: 'fixture_b', body: TEMPLATE },
    { author: 'fixture_c', body: `${TEMPLATE} ${GENUINE_ADDITION}` }
  ] };
  const { prompts, saved } = await analyze(raw, () => emptyOutput(), env);
  const prompt = prompts[0];
  assert.strictEqual(commentLabels(prompt), 1, 'the pure-template comment must be excluded, the augmented one kept');
  assert.ok(prompt.includes(GENUINE_ADDITION), 'the genuine added sentence must reach the model');
  assert.ok(!prompt.includes('critique circle'), 'the template sentences must not reach the model');
  assert.deepStrictEqual(saved[0].meta.botCommentsFilterReasons,
    { 'boilerplate-fingerprint': 1, 'boilerplate-fingerprint-partial': 1 });
});

// ---- T4 (negative control) -------------------------------------------------

test('T4: two genuine commenters with the same opinion are both preserved — repetition does not exclude', async () => {
  const env = { BOILERPLATE_FINGERPRINTS: fingerprintsOf(TEMPLATE).join(',') };
  const comments = [{ author: 'fixture_d', body: SHARED_OPINION }, { author: 'fixture_e', body: SHARED_OPINION }];
  const direct = filterComments(comments, { fingerprints: new Set(fingerprintsOf(TEMPLATE)) });
  assert.strictEqual(direct.kept.length, 2);
  assert.strictEqual(direct.strippedCount, 0);

  const { prompts, saved } = await analyze({ post: POST, comments }, () => {
    const out = emptyOutput();
    out.pain_points = [
      { item: 'grammar plugin flattens dialogue', quote: 'kept rewriting my dialogue', speaker: 'comment 1' },
      { item: 'grammar plugin flattens dialogue', quote: 'kept rewriting my dialogue', speaker: 'comment 2' }
    ];
    return out;
  }, env);
  assert.strictEqual(commentLabels(prompts[0]), 2);
  assert.strictEqual(saved[0].analysis.pain_points.length, 2);
  assert.deepStrictEqual(saved[0].analysis.grounding.drops, {});
});

// ---- T5 --------------------------------------------------------------------

test('T5: every list item in the output schema requires quote + speaker, and persona.goal carries an evidence quote', () => {
  const props = ANALYSIS_SCHEMA.properties;
  const lists = Object.entries(props).filter(([, v]) => v.type === 'array' && v.items.type === 'object');
  assert.deepStrictEqual(lists.map(([k]) => k).sort(), ['deal_breakers', 'ethics_concerns', 'expected_baseline',
    'feature_requests', 'pain_points', 'tools_mentioned', 'trust_signals']);
  for (const [field, schema] of lists) {
    for (const key of ['quote', 'speaker']) {
      assert.ok(schema.items.required.includes(key), `${field} items must require ${key}`);
    }
  }
  assert.ok(props.persona.required.includes('goal_quote') && props.persona.required.includes('goal_speaker'));
  assert.ok(ANALYSIS_SCHEMA.required.includes('notable_quote_speaker'));
});

test('T5: a quote must normalize-match text in its attributed unit (case, whitespace, links, emphasis, escapes, curly quotes)', () => {
  const post = { title: 'Revision tracking', selftext: 'I tried **colour coding** and [the \\_notes\\_ panel](https://example.invalid) but it’s   still\nMESSY.' };
  const comments = [{ body: HUMAN_B }];
  const item = (quote, speaker) => ({ item: 'x', quote, speaker });
  const { analysis, drops } = validateAnalysis({ pain_points: [
    item('colour coding and the _notes_ panel', 'post'),
    item("but it's still messy", 'post'),
    item('printed copy', 'comment 1'),
    item('printed copy', 'post'),          // different speaker's unit
    item('colour coding', 'comment 1'),    // different speaker's unit
    item('printed copy', 'comment 2'),     // no such unit
    item('printed copy', 'the op'),        // unparseable speaker
    item('', 'post')                       // no quote
  ] }, { post, comments });
  assert.strictEqual(analysis.pain_points.length, 3);
  assert.strictEqual(drops.pain_points, 5);
});

test('T5: an item whose quote exists only in an excluded unit is rejected, whichever speaker it names', async () => {
  const raw = { post: POST, comments: [
    { author: 'fixture_a', body: HUMAN_A },
    { author: 'examplewriters-ModTeam', body: MOD_NOTE },
    { author: 'fixture_b', body: HUMAN_B }
  ] };
  const { saved } = await analyze(raw, () => {
    const out = emptyOutput();
    out.trust_signals = ['post', 'comment 1', 'comment 2', 'comment 3'].map((speaker) =>
      ({ signal: 'rule enforcement', direction: 'builds', quote: 'under rule four', speaker }));
    out.trust_signals.push({ signal: 'paper markup', direction: 'builds', quote: 'mark up a printed copy', speaker: 'comment 2' });
    return out;
  });
  assert.deepStrictEqual(saved[0].analysis.trust_signals.map((t) => t.quote), ['mark up a printed copy']);
  assert.strictEqual(saved[0].analysis.grounding.drops.trust_signals, 4);
});

// ---- T6 --------------------------------------------------------------------

test('T6: comment_stance_mix ignores excluded units — the model never sees them, and an overcount is rejected', async () => {
  const raw = { post: POST, comments: [
    { author: 'fixture_a', body: HUMAN_A },
    { author: 'examplewriters-ModTeam', body: MOD_NOTE },
    { author: 'fixture_b', body: HUMAN_B },
    { author: 'AutoModerator', body: AUTOMOD_WELCOME },
    { author: 'fixture_c', body: HUMAN_C }
  ] };
  const mix = (hostile) => ({ hostile, wary: 0, conflicted: 0, curious: 0, pragmatic: 2, enthusiastic: 0 });

  const counted = await analyze(raw, () => ({ ...emptyOutput(), comment_stance_mix: mix(1) }));
  assert.strictEqual(commentLabels(counted.prompts[0]), 3, 'only the three human comments may be shown');
  assert.deepStrictEqual(counted.saved[0].analysis.comment_stance_mix, mix(1));

  // A mix that counts the two excluded units as hostile cannot be honest.
  const over = await analyze(raw, () => ({ ...emptyOutput(), comment_stance_mix: mix(3) }));
  assert.deepStrictEqual(over.saved[0].analysis.comment_stance_mix,
    { hostile: 0, wary: 0, conflicted: 0, curious: 0, pragmatic: 0, enthusiastic: 0 });
  assert.strictEqual(over.saved[0].analysis.grounding.dropReasons['comment_stance_mix:overcount'], 1);
});

// ---- T7 --------------------------------------------------------------------

test('T7: empty lists validate and no field requires a minimum count', () => {
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    assert.ok(!('minItems' in node), `${path} declares minItems`);
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  walk(ANALYSIS_SCHEMA, 'schema');
  const { analysis, drops, checked } = validateAnalysis(emptyOutput(), { post: POST, comments: [] });
  assert.deepStrictEqual(drops, {});
  assert.strictEqual(checked, 0);
  for (const field of ['pain_points', 'expected_baseline', 'deal_breakers', 'trust_signals', 'feature_requests', 'ethics_concerns', 'tools_mentioned']) {
    assert.deepStrictEqual(analysis[field], []);
  }
});

// ---- T8 --------------------------------------------------------------------

test('T8: a feature_requests item must carry basis ∈ {explicit_request, existing_usage, implied_need}', () => {
  const schema = ANALYSIS_SCHEMA.properties.feature_requests.items;
  assert.deepStrictEqual(schema.properties.basis.enum, ['explicit_request', 'existing_usage', 'implied_need']);
  assert.deepStrictEqual(FEATURE_BASIS, schema.properties.basis.enum);
  assert.ok(schema.required.includes('basis'));

  const comments = [{ body: HUMAN_A }];
  const feature = (basis) => ({ feature: 'spreadsheet outline', ai_related: false, basis, quote: 'outline in a spreadsheet', speaker: 'comment 1' });
  const { analysis, dropReasons } = validateAnalysis({ feature_requests: [
    feature('explicit_request'), feature('existing_usage'), feature('implied_need'),
    feature('wishlist'), feature(undefined)
  ] }, { post: POST, comments });
  assert.deepStrictEqual(analysis.feature_requests.map((f) => f.basis), ['explicit_request', 'existing_usage', 'implied_need']);
  assert.strictEqual(dropReasons['feature_requests:bad-basis'], 2);
});

// ---- legacy tolerance (F2, per-row isolation) ------------------------------

test('rollup reads legacy string items and grounded object items alike, and never crashes on a malformed one', () => {
  const row = (analysis, i) => ({ partitionKey: 'examplewriters', rowKey: `r${i}`, analysisJson: JSON.stringify(analysis) });
  const { items, skipped } = parseRows([
    row({ pain_points: ['lost revisions'], expected_baseline: ['autosave'], ethics_concerns: ['consent'] }, 1),
    row({ pain_points: [{ item: 'lost revisions', quote: 'q', speaker: 'post' }, 7, null, { quote: 'no label' }],
      expected_baseline: [{ item: 'autosave', quote: 'q', speaker: 'post' }], ethics_concerns: [] }, 2)
  ]);
  assert.strictEqual(skipped, 0);
  assert.deepStrictEqual(items.map((r) => r.painPoints), [['lost revisions'], ['lost revisions']]);
  assert.deepStrictEqual(items.map((r) => r.expectedBaseline), [['autosave'], ['autosave']]);
  assert.deepStrictEqual(items.map((r) => r.ethics), [['consent'], []]);
});
