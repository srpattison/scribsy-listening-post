'use strict';

// §3a–§3c — bot/boilerplate detection, tagging, and exclusion from sentiment.
//
// The defect: AutoModerator megathreads recur on a schedule, so a 12-month
// backfill captures dozens of byte-identical copies per sub, each carrying the
// subreddit's rule text. Frequency-weighted aggregates read that as writer
// sentiment. Because the repetition is systematic rather than random, it biases
// the corpus toward appearing anti-AI — corrupting exactly the questions the
// system exists to answer.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cc = require('../src/lib/content-class');
const engine = require('../src/lib/rollup-engine');

// The actual string Steven spotted on the live dashboard, 2026-08-16.
const RULE_TEXT =
  'Please read the rules before posting. Requests for critique must include a ' +
  'sample of your own work. AI generated feedback and reviews is also not allowed. ' +
  'Low effort posts will be removed by the moderators without warning.';

const MEGATHREAD_TITLE = 'Able to beta? Post here! Weekly beta reader matching thread for our community members';

// ---------------------------------------------------------------------------
// §3a — general detection
// ---------------------------------------------------------------------------

test('normalisation collapses the incidental differences between copies', () => {
  const a = cc.normalizeText('**Please read the rules** before posting.   See https://example.com/x  2026-08-16');
  const b = cc.normalizeText('Please read the RULES before posting. See https://example.com/y 2026-08-01');
  assert.strictEqual(a, b, 'markdown, case, urls, whitespace and date stamps must not split a hash');
});

test('repeat-hash flags boilerplate posted by ORDINARY DISTINCT usernames', () => {
  // The general case: a submission template the subreddit injects into post
  // bodies. No bot author, no distinguished flag, no sticky. If this only
  // passed for AutoModerator, the secondary signal would be doing all the work
  // and the general detector would be untested.
  const rows = Array.from({ length: 8 }, (_, i) => ({
    subreddit: 'betareaders',
    author: `ordinary_writer_${i}`,
    title: `My novel, chapter ${i}`,
    body: RULE_TEXT
  }));
  const index = cc.buildRepeatIndex(rows);
  const classified = rows.map((r) => cc.classifyRow(r, index));

  assert.ok(classified.every((c) => c.contentClass === cc.CLASS_BOILERPLATE));
  assert.ok(classified.every((c) => c.contentClassReason === 'repeat-hash'),
    'the general detector must be what fires, not an author allowlist');
});

test('repeat-hash flags repeated megathread TITLES independently of bodies', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    subreddit: 'betareaders',
    author: `person_${i}`,          // deliberately not AutoModerator
    title: MEGATHREAD_TITLE,
    body: `unique body number ${i}`
  }));
  const index = cc.buildRepeatIndex(rows);
  assert.ok(rows.every((r) => cc.classifyRow(r, index).contentClass === cc.CLASS_BOILERPLATE));
});

test('the title floor still blocks ordinary short titles', () => {
  // The title floor (40) is lower than the body floor (120), so it needs its
  // own false-positive check: ordinary headlines must stay under it.
  for (const t of ['Looking for beta readers', 'Help with chapter 3', 'Query letter feedback?']) {
    assert.ok(cc.normalizeText(t).length < cc.DEFAULT_MIN_TITLE_CHARS,
      `"${t}" (${cc.normalizeText(t).length} chars) must stay below the title floor`);
    assert.strictEqual(cc.hashIfEligible(t, cc.DEFAULT_MIN_TITLE_CHARS), null);
  }
  const rows = Array.from({ length: 30 }, (_, i) => ({
    subreddit: 'writing', author: `w${i}`, title: 'Looking for beta readers', body: `draft ${i}`
  }));
  const index = cc.buildRepeatIndex(rows);
  assert.ok(rows.every((r) => cc.classifyRow(r, index).contentClass === cc.CLASS_HUMAN));
});

test('the false-positive guard: common human phrasing is never flagged', () => {
  // "good luck with your draft" normalises to 25 characters — far below the
  // 120-character floor — so no amount of repetition can flag it.
  const phrase = 'Good luck with your draft!';
  assert.ok(cc.normalizeText(phrase).length < cc.DEFAULT_MIN_CHARS);

  const rows = Array.from({ length: 50 }, (_, i) => ({
    subreddit: 'writing',
    author: `writer_${i}`,
    title: `Question about pacing ${i}`,
    body: phrase
  }));
  const index = cc.buildRepeatIndex(rows);
  assert.ok(rows.every((r) => cc.classifyRow(r, index).contentClass === cc.CLASS_HUMAN),
    'fifty writers saying the same encouraging sentence are still fifty writers');
  assert.strictEqual(cc.hashIfEligible(phrase), null, 'short text is not even hashed');
});

test('repeats below the threshold are left alone', () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    subreddit: 'writing', author: `w${i}`, title: `t${i}`, body: RULE_TEXT
  }));
  const index = cc.buildRepeatIndex(rows);
  assert.ok(rows.every((r) => cc.classifyRow(r, index, { minRepeats: 5 }).contentClass === cc.CLASS_HUMAN));
});

test('repeats are counted per subreddit, not globally', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    subreddit: `sub${i}`, author: `w${i}`, title: `t${i}`, body: RULE_TEXT
  }));
  const index = cc.buildRepeatIndex(rows);
  assert.ok(rows.every((r) => cc.classifyRow(r, index).contentClass === cc.CLASS_HUMAN),
    'the same text once in each of eight subs is not boilerplate in any of them');
});

test('secondary signals fire, with bot outranking boilerplate', () => {
  const base = { subreddit: 'betareaders', title: 'x', body: 'y' };
  assert.deepStrictEqual(cc.classifyRow({ ...base, author: 'AutoModerator' }, null),
    { contentClass: cc.CLASS_BOT, contentClassReason: 'automod-author' });
  assert.deepStrictEqual(cc.classifyRow({ ...base, author: 'automoderator' }, null),
    { contentClass: cc.CLASS_BOT, contentClassReason: 'automod-author' }, 'case-insensitive');
  assert.deepStrictEqual(cc.classifyRow({ ...base, author: 'a_mod', distinguished: 'moderator' }, null),
    { contentClass: cc.CLASS_BOT, contentClassReason: 'distinguished' });
  assert.deepStrictEqual(cc.classifyRow({ ...base, author: 'a_mod', stickied: true }, null),
    { contentClass: cc.CLASS_BOILERPLATE, contentClassReason: 'stickied' });
  assert.strictEqual(cc.classifyRow({ ...base, author: 'a_writer' }, null).contentClass, cc.CLASS_HUMAN);
});

test('an untagged row reads as human', () => {
  assert.strictEqual(cc.isHuman({}), true);
  assert.strictEqual(cc.isHuman({ contentClass: 'bot' }), false);
  assert.strictEqual(cc.isHuman({ contentClass: 'boilerplate' }), false);
});

// ---------------------------------------------------------------------------
// §5 — the measurement that defined the defect must flip
// ---------------------------------------------------------------------------

const analysisWithRuleText = JSON.stringify({
  ai_related: true,
  stance_on_ai: 'hostile',
  topics: ['community-norms'],
  trust_signals: [{ direction: 'breaks', signal: 'AI feedback banned', quote: RULE_TEXT }],
  notable_quote: RULE_TEXT,
  summary: RULE_TEXT,
  week: '2026-W33'
});

const humanAnalysis = (i) => JSON.stringify({
  ai_related: true,
  stance_on_ai: 'curious',
  topics: ['tools-workflow'],
  notable_quote: `I tried an outliner this week and it helped me finish chapter ${i}.`,
  summary: 'a writer describing their workflow',
  week: '2026-W33'
});

// N identical AutoModerator megathreads plus some genuine writers.
function contaminatedCorpus(n = 8) {
  const bots = Array.from({ length: n }, (_, i) => ({
    partitionKey: 'betareaders', rowKey: `bot${i}`, author: 'AutoModerator',
    title: MEGATHREAD_TITLE, permalink: `/r/betareaders/comments/bot${i}/`,
    createdUtc: 1_760_000_000 + i, analysisJson: analysisWithRuleText
  }));
  const humans = Array.from({ length: 6 }, (_, i) => ({
    partitionKey: 'betareaders', rowKey: `hum${i}`, author: `writer_${i}`,
    title: `Looking for a beta reader for my SF novella ${i}`,
    permalink: `/r/betareaders/comments/hum${i}/`,
    createdUtc: 1_760_100_000 + i, analysisJson: humanAnalysis(i)
  }));
  return [...bots, ...humans];
}

const textOf = (payload) => JSON.stringify(payload);

test('rule text never reaches stance or quote output', () => {
  const { items } = engine.parseRows(contaminatedCorpus());
  const rows = engine.classifyUntagged(items, {});
  const human = rows.filter(cc.isHuman);

  assert.strictEqual(human.length, 6, 'only the genuine writers survive');
  assert.ok(!textOf(human).includes('AI generated feedback and reviews is also not allowed'),
    'the rule text must not appear anywhere in the filtered corpus');

  // And the stance frame is no longer skewed hostile by the repeats.
  const stances = human.map((r) => r.stance);
  assert.ok(!stances.includes('hostile'),
    'eight bot copies must not contribute eight hostile stances');
});

test('with the detector disabled, the same corpus DOES leak it (proves the check can fail)', () => {
  const { items } = engine.parseRows(contaminatedCorpus());
  // No classification pass — this is the pre-fix behaviour.
  assert.ok(textOf(items).includes('AI generated feedback and reviews is also not allowed'),
    'the unfiltered corpus must leak the rule text, or the check above is vacuous');
  const stances = items.map((r) => r.stance);
  assert.strictEqual(stances.filter((s) => s === 'hostile').length, 8,
    'unfiltered, the bot copies contribute eight hostile stances to a 14-row corpus');
});

test('the bias is directional: exclusion changes the stance distribution', () => {
  const { items } = engine.parseRows(contaminatedCorpus());
  const rows = engine.classifyUntagged(items, {});
  const share = (set) => set.filter((r) => r.stance === 'hostile').length / set.length;

  const unfiltered = share(items);
  const filtered = share(rows.filter(cc.isHuman));
  assert.ok(unfiltered > 0.5, `unfiltered corpus reads ${Math.round(unfiltered * 100)}% hostile`);
  assert.strictEqual(filtered, 0, 'filtered corpus carries none of the manufactured hostility');
});

test('excluded rows are tagged, not deleted', () => {
  const { items } = engine.parseRows(contaminatedCorpus());
  const rows = engine.classifyUntagged(items, {});
  assert.strictEqual(rows.length, items.length, 'nothing is removed from the corpus');
  const excluded = rows.filter((r) => !cc.isHuman(r));
  assert.strictEqual(excluded.length, 8);
  assert.ok(excluded.every((r) => r.contentClassReason === 'automod-author'));
  // The rule text is still available — as its own signal, in the rules frame.
  assert.ok(textOf(excluded).includes('AI generated feedback and reviews is also not allowed'));
});

test('a stored contentClass is respected over on-the-fly classification', () => {
  const { items } = engine.parseRows([{
    partitionKey: 'writing', rowKey: 'x', author: 'AutoModerator', title: 't',
    contentClass: 'human', // explicitly reviewed and cleared
    analysisJson: humanAnalysis(1)
  }]);
  const rows = engine.classifyUntagged(items, {});
  assert.strictEqual(rows[0].contentClass, 'human', 'retag decisions are not second-guessed');
});

// ---------------------------------------------------------------------------
// §5 — grep assertion: no sentiment section reads unfiltered rows
// ---------------------------------------------------------------------------

const SENTIMENT_SECTIONS = [
  'heatmap', 'stance', 'distributions', 'features', 'minbar', 'trust', 'cohort',
  'quotes', 'personas', 'competitors', 'resonance', 'signals', 'discovery'
];

// Slice the engine source into per-section blocks by their `name:` markers.
function sectionBodies(src) {
  const out = {};
  const marks = [...src.matchAll(/^ {6}name: '([a-zA-Z]+)',$/gm)];
  marks.forEach((m, i) => {
    const start = m.index;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    out[m[1]] = src.slice(start, end);
  });
  return out;
}

// `rows` / `aiRows` that are not the `humanRows` / `humanAiRows` names.
function unfilteredRefs(body) {
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/\bhumanAiRows\b/g, 'OK').replace(/\bhumanRows\b/g, 'OK')
    .replace(/\bnonHumanRows\b/g, 'OK').replace(/\bforEachRow\b/g, 'OK')
    .replace(/\bframeRows\b/g, 'OK').replace(/\brawFeatures\b/g, 'OK');
  return [...code.matchAll(/\b(rows|aiRows)\b/g)].map((m) => m[1]);
}

const ENGINE = path.join(__dirname, '..', 'src', 'lib', 'rollup-engine.js');

for (const name of SENTIMENT_SECTIONS) {
  test(`section '${name}' reads only human-filtered rows`, () => {
    const bodies = sectionBodies(fs.readFileSync(ENGINE, 'utf8'));
    assert.ok(bodies[name], `section '${name}' must exist in the engine`);
    assert.deepStrictEqual(unfilteredRefs(bodies[name]), [],
      `section '${name}' references the unfiltered corpus`);
  });
}

test('the grep assertion rejects the pre-fix engine (proves it can fail)', () => {
  const fixture = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'pre-round5-sentiment-sections.txt'), 'utf8');
  const bodies = sectionBodies(fixture);
  const offenders = Object.entries(bodies)
    .filter(([n]) => SENTIMENT_SECTIONS.includes(n))
    .filter(([, b]) => unfilteredRefs(b).length > 0)
    .map(([n]) => n);
  assert.ok(offenders.length >= 5,
    `expected the pre-fix sections to trip the scanner, got: ${offenders.join(', ')}`);
});
