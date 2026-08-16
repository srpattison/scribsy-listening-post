'use strict';

// §3b/§4 — bot text must not enter the analyze prompt.
//
// THE PROMPT IS ASSERTED DIRECTLY. Checking only that the quotes came out clean
// is weaker: it cannot distinguish "the filter worked" from "the model happened
// not to quote that comment". So every test here spies on the AOAI client and
// inspects the constructed prompt string.

const test = require('node:test');
const assert = require('node:assert');

const { analyzePost } = require('../src/lib/aoai');
const { filterComments, classifyComment } = require('../src/lib/comment-filter');
const cc = require('../src/lib/content-class');
const registry = require('../src/lib/boilerplate-registry');

const RULE_TEXT =
  'Please read the rules before posting. Requests for critique must include a ' +
  'sample of your own work. AI generated feedback and reviews is also not allowed. ' +
  'Low effort posts will be removed by the moderators without warning.';

const HUMAN_COMMENT = 'I would happily beta this — send me the first three chapters and I will mark it up.';

// A human opinion that RESEMBLES a rule statement. This is real sentiment and
// must survive: losing it would bias the corpus the opposite way.
const HUMAN_RULE_LIKE = "I don't think AI feedback should be allowed here, it defeats the point of a critique swap.";

const POST = {
  subreddit: 'betareaders',
  title: 'Looking for a beta reader for my SF novella',
  selftext: 'Third draft, 28k words, seeking structural feedback.',
  created_utc: 1_760_000_000,
  source: 'reddit'
};

// Capture the prompt the model would have been sent.
function spyChat() {
  const seen = [];
  const chat = async (system, user) => {
    seen.push({ system, user });
    return { ai_related: true, stance_on_ai: 'na', topics: [], notable_quote: '', summary: '' };
  };
  return { chat, seen, lastPrompt: () => seen[seen.length - 1].user };
}

async function promptFor(comments, opts = {}) {
  const spy = spyChat();
  const { kept, reasons, filteredCount } = filterComments(comments, opts);
  await analyzePost(POST, kept, { chat: spy.chat });
  return { prompt: spy.lastPrompt(), reasons, filteredCount, kept };
}

// ---------------------------------------------------------------------------
// Each detector, asserted on the prompt itself
// ---------------------------------------------------------------------------

test('AutoModerator comment text never reaches the prompt', async () => {
  const { prompt, reasons, filteredCount } = await promptFor([
    { author: 'AutoModerator', body: RULE_TEXT },
    { author: 'a_writer', body: HUMAN_COMMENT }
  ]);
  assert.ok(!prompt.includes('AI generated feedback and reviews is also not allowed'));
  assert.ok(!prompt.includes(RULE_TEXT));
  assert.ok(prompt.includes(HUMAN_COMMENT), 'the genuine comment must still be there');
  assert.strictEqual(filteredCount, 1);
  assert.deepStrictEqual(reasons, { 'automod-author': 1 });
});

test('a distinguished moderator comment never reaches the prompt', async () => {
  const { prompt, reasons } = await promptFor([
    { author: 'some_mod', distinguished: 'moderator', body: RULE_TEXT },
    { author: 'a_writer', body: HUMAN_COMMENT }
  ]);
  assert.ok(!prompt.includes(RULE_TEXT));
  assert.ok(prompt.includes(HUMAN_COMMENT));
  assert.deepStrictEqual(reasons, { distinguished: 1 });
});

test('a stickied comment never reaches the prompt', async () => {
  const { prompt, reasons } = await promptFor([
    { author: 'some_mod', stickied: true, body: RULE_TEXT },
    { author: 'a_writer', body: HUMAN_COMMENT }
  ]);
  assert.ok(!prompt.includes(RULE_TEXT));
  assert.ok(prompt.includes(HUMAN_COMMENT));
  assert.deepStrictEqual(reasons, { stickied: 1 });
});

// ---------------------------------------------------------------------------
// §4 — the REGISTRY path, verified in isolation
// ---------------------------------------------------------------------------
//
// If every passing fixture also tripped a per-row signal, §3a would be untested
// and the "secondary signal doing all the work" failure would have been
// reproduced one layer down. So this comment has an ordinary username, no
// `distinguished`, no `stickied` — it is caught ONLY by a registry hash.

test('a registry hash alone keeps a comment out of the prompt', async () => {
  const comment = { author: 'ordinary_person', body: RULE_TEXT };

  // Confirm no per-row signal applies to it.
  assert.strictEqual(classifyComment(comment, { registry: new Set() }).keep, true,
    'without the registry this comment is indistinguishable from a human one');

  const hashes = new Set([cc.hashIfEligible(RULE_TEXT, cc.DEFAULT_MIN_CHARS)]);
  const { prompt, reasons, filteredCount } = await promptFor(
    [comment, { author: 'a_writer', body: HUMAN_COMMENT }],
    { registry: hashes }
  );

  assert.ok(!prompt.includes(RULE_TEXT), 'registry hit must keep it out of the prompt');
  assert.ok(prompt.includes(HUMAN_COMMENT));
  assert.strictEqual(filteredCount, 1);
  assert.deepStrictEqual(reasons, { 'registry-hash': 1 });
});

test('the registry matches through markdown, case and date-stamp differences', async () => {
  const stored = new Set([cc.hashIfEligible(RULE_TEXT, cc.DEFAULT_MIN_CHARS)]);
  const variant = `**PLEASE READ THE RULES** before posting. Requests for critique must include a ` +
    `sample of your own work. AI generated feedback and reviews is also not allowed. ` +
    `Low effort posts will be removed by the moderators without warning.  2026-08-16`;
  const { prompt } = await promptFor([{ author: 'ordinary_person', body: variant }], { registry: stored });
  assert.ok(!prompt.includes('AI generated feedback and reviews is also not allowed'),
    'normalisation must survive the incidental differences between copies');
});

// ---------------------------------------------------------------------------
// False-positive guard
// ---------------------------------------------------------------------------

test('a human opinion that resembles a rule is NOT filtered', async () => {
  const hashes = new Set([cc.hashIfEligible(RULE_TEXT, cc.DEFAULT_MIN_CHARS)]);
  const { prompt, filteredCount } = await promptFor(
    [{ author: 'a_writer', body: HUMAN_RULE_LIKE }],
    { registry: hashes }
  );
  assert.strictEqual(filteredCount, 0, 'this is real sentiment; losing it biases the corpus the other way');
  assert.ok(prompt.includes(HUMAN_RULE_LIKE));
});

test('short comments are never registry-matched', async () => {
  // Below the body floor nothing is hashed, so a short comment cannot collide
  // with a stored hash however common its phrasing.
  const short = { author: 'a_writer', body: 'Good luck with your draft!' };
  assert.strictEqual(classifyComment(short, { registry: new Set(['deadbeefdeadbeef']) }).keep, true);
});

// ---------------------------------------------------------------------------
// Proves the assertions can fail: the pre-fix path passed comments unfiltered
// ---------------------------------------------------------------------------

test('unfiltered comments DO reach the prompt (pre-fix behaviour)', async () => {
  const spy = spyChat();
  // This is exactly what analyze.js did at c119619: raw.comments straight in.
  await analyzePost(POST, [
    { author: 'AutoModerator', body: RULE_TEXT },
    { author: 'a_writer', body: HUMAN_COMMENT }
  ], { chat: spy.chat });

  assert.ok(spy.lastPrompt().includes('AI generated feedback and reviews is also not allowed'),
    'the unfiltered prompt must carry the bot text, or the assertions above are vacuous');
});

test('engagement counts are still absent from the prompt (round 4 contract)', async () => {
  const spy = spyChat();
  await analyzePost({ ...POST, score: 4242 }, [{ author: 'a', body: HUMAN_COMMENT, scoreAtCapture: 99 }], { chat: spy.chat });
  assert.ok(!spy.lastPrompt().includes('4242'));
  assert.ok(!spy.lastPrompt().includes('99]'));
});

// ---------------------------------------------------------------------------
// Registry plumbing
// ---------------------------------------------------------------------------

function fakeStore() {
  const saved = new Map();
  return {
    saved,
    saveAggregate: async (p, k, v) => { saved.set(`${p}|${k}`, v); },
    getAggregate: async (p, k) => saved.get(`${p}|${k}`) || null,
    listAggregates: async (p) => [...saved.entries()]
      .filter(([key]) => key.startsWith(`${p}|`))
      .map(([key, v]) => ({ period: key.split('|')[1], ...v }))
  };
}

test('fromRepeatIndex only harvests hashes past the repeat threshold', () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => ({ subreddit: 'betareaders', author: `w${i}`, title: `t${i}`, body: RULE_TEXT })),
    ...Array.from({ length: 2 }, (_, i) => ({ subreddit: 'writing', author: `w${i}`, title: `t${i}`, body: RULE_TEXT }))
  ];
  const index = cc.buildRepeatIndex(rows);
  const out = registry.fromRepeatIndex(index, { minRepeats: 5 });
  assert.ok(out.betareaders, 'eight repeats qualify');
  assert.strictEqual(out.writing, undefined, 'two repeats do not');
  assert.strictEqual(Object.values(out.betareaders)[0].repeats, 8);
});

test('registry merges across passes instead of replacing', async () => {
  const store = fakeStore();
  // Rollup sees titles only.
  await registry.merge(store, { betareaders: { titlehash: { repeats: 9, kind: 'title' } } }, {});
  // Retag later sees bodies.
  await registry.merge(store, { betareaders: { bodyhash: { repeats: 7, kind: 'body' } } }, {});

  const row = await store.getAggregate(registry.PARTITION, 'betareaders');
  assert.deepStrictEqual(Object.keys(row.hashes).sort(), ['bodyhash', 'titlehash'],
    'a pass that saw only titles must not wipe what another pass found in bodies');
  assert.strictEqual(row.count, 2);
});

test('merging keeps the strongest evidence for a hash', async () => {
  const store = fakeStore();
  await registry.merge(store, { s: { h: { repeats: 12, kind: 'body' } } }, {});
  await registry.merge(store, { s: { h: { repeats: 6, kind: 'body' } } }, {});
  const row = await store.getAggregate(registry.PARTITION, 's');
  assert.strictEqual(row.hashes.h.repeats, 12);
});

test('load returns a Set the filter can use, and tolerates a missing row', async () => {
  const store = fakeStore();
  assert.strictEqual((await registry.load(store, 'nothing-here')).size, 0);
  await registry.merge(store, { writing: { abc: { repeats: 9, kind: 'body' } } }, {});
  const set = await registry.load(store, 'WRITING');
  assert.ok(set.has('abc'), 'lookup is case-insensitive on the subreddit');
});

test('the cache serves repeat lookups without re-reading', async () => {
  const store = fakeStore();
  await registry.merge(store, { writing: { abc: { repeats: 9, kind: 'body' } } }, {});
  let reads = 0;
  const counting = { ...store, getAggregate: async (p, k) => { reads++; return store.getAggregate(p, k); } };
  const cache = registry.createCache(counting, { ttlMs: 60_000 });
  await cache.get('writing');
  await cache.get('writing');
  await cache.get('writing');
  assert.strictEqual(reads, 1, 'the analyze queue calls this once per message; it must not re-read each time');
});

test('a registry read failure degrades to no filtering rather than failing analysis', async () => {
  const broken = { getAggregate: async () => { throw new Error('storage down'); } };
  const cache = registry.createCache(broken);
  const set = await cache.get('writing');
  assert.strictEqual(set.size, 0, 'per-row signals still apply; analysis must not be blocked');
});

test('summarize reports hashes per sub', async () => {
  const store = fakeStore();
  await registry.merge(store, {
    betareaders: { a: { repeats: 9 }, b: { repeats: 8 } },
    writing: { c: { repeats: 6 } }
  }, {});
  const s = await registry.summarize(store);
  assert.strictEqual(s.subs, 2);
  assert.strictEqual(s.hashes, 3);
  assert.deepStrictEqual(s.bySub, { betareaders: 2, writing: 1 });
});
