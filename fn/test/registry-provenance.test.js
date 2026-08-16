'use strict';

// CB-LISTEN-REPO-7 §8o — the boilerplate registry held no comment-derived
// hashes, so analyze-time repeat-hash was inert against comment boilerplate.
//
// Measured: retag-time repeat-hash caught 725/1,701 flagged rows (43%); the
// same day, analyze-time registry-hash fired on 2/1,871 (0.1%) — a ~400x gap.
// Cause: `fromRepeatIndex` tagged every body-derived hash `kind: 'body'`
// regardless of whether the source text was a submission body (retag) or a
// comment body (the contamination scan) — and the contamination scan, the
// only pass that ever reads comment bodies, had never completed (§8l/§8m).
// So the registry's hashes were title/submission-derived only, and
// `comment-filter.js` — which hashes `comment.body` — could essentially never
// match.
//
// The pair of tests below is what distinguishes "the registry protects
// comments" from "the registry happens to be populated": the same comment
// fixture must be filtered by a comment-derived registry and must NOT be
// filtered by a registry built only from titles/submission bodies, which is
// exactly the corpus the pre-fix registry was limited to.

const test = require('node:test');
const assert = require('node:assert');

const cc = require('../src/lib/content-class');
const registry = require('../src/lib/boilerplate-registry');
const { classifyComment } = require('../src/lib/comment-filter');

function fakeStore() {
  const saved = new Map();
  return {
    saveAggregate: async (p, k, v) => { saved.set(`${p}|${k}`, v); },
    getAggregate: async (p, k) => saved.get(`${p}|${k}`) || null,
    listAggregates: async (p) => [...saved.entries()]
      .filter(([key]) => key.startsWith(`${p}|`))
      .map(([key, v]) => ({ period: key.split('|')[1], ...v }))
  };
}

// Sub-agnostic, ordinary-author critique-thread boilerplate: no per-row signal
// (no automod author, not distinguished, not stickied), long enough to hash
// (>120 chars normalised).
const COMMENT_TEXT =
  'Please read the sidebar before posting your critique request. Include a ' +
  'sample of your own writing and specify what kind of feedback you want. ' +
  'Off-topic threads will be removed by the moderators.';

test('COMMENT_TEXT fixture is eligible for hashing and trips no per-row signal', () => {
  assert.ok(cc.normalizeText(COMMENT_TEXT).length >= cc.DEFAULT_MIN_CHARS);
  const comment = { author: 'ordinary_user_42', body: COMMENT_TEXT };
  assert.strictEqual(classifyComment(comment, { registry: new Set() }).keep, true,
    'without the registry this must be indistinguishable from a human comment');
});

test('§8o: a comment repeated only across COMMENTS is filtered once the comment-body harvest runs', async () => {
  const store = fakeStore();
  const comment = { author: 'ordinary_user_42', body: COMMENT_TEXT };

  // What scanContamination builds: an index over comment bodies only (title
  // is always '' for a comment row — see lib/retag.js's perRow.comments map).
  const commentRows = Array.from({ length: 8 }, (_, i) => ({
    subreddit: 'betareaders', author: `person_${i}`, title: '', body: COMMENT_TEXT
  }));
  const commentIndex = cc.buildRepeatIndex(commentRows);
  const discovered = registry.fromRepeatIndex(commentIndex, { minRepeats: 5, bodyKind: 'comment-body' });
  assert.ok(discovered.betareaders, 'eight repeats past minRepeats=5 must qualify');
  await registry.merge(store, discovered, {});

  const set = await registry.load(store, 'betareaders');
  const result = classifyComment(comment, { registry: set });
  assert.strictEqual(result.keep, false, 'a comment-derived registry hash must filter this comment');
  assert.strictEqual(result.reason, 'registry-hash');

  const summary = await registry.summarize(store);
  assert.strictEqual(summary.bySource.betareaders['comment-body'], 1,
    'registry composition must be reported by source, not just a bare count (§8o requirement 3)');
});

test('§8o: the SAME comment is NOT filtered by a registry built only from titles/submission bodies', async () => {
  const store = fakeStore();
  const comment = { author: 'ordinary_user_42', body: COMMENT_TEXT };

  // What runRetag builds by default: an index over submission titles/bodies.
  // This corpus never contains the comment's text at all — the pre-fix
  // registry's actual limitation, since the contamination scan never ran.
  const submissionRows = Array.from({ length: 8 }, (_, i) => ({
    subreddit: 'betareaders',
    author: `writer_${i}`,
    title: 'Weekly beta-partner matching thread — post here to find a reader',
    body: 'This is unrelated submission template text with no connection to the ' +
      'comment fixture above, long enough on its own to be hash-eligible for this test.'
  }));
  const index = cc.buildRepeatIndex(submissionRows);
  const discovered = registry.fromRepeatIndex(index, { minRepeats: 5 }); // default bodyKind: 'body'
  await registry.merge(store, discovered, {});

  const set = await registry.load(store, 'betareaders');
  assert.strictEqual(classifyComment(comment, { registry: set }).keep, true,
    'a submission/title-only registry never saw the comment text and must not filter it — ' +
    'this is what distinguishes "registry works" from "registry is populated"');
});

test('summarize reports registry composition by source, per sub', async () => {
  const store = fakeStore();
  await registry.merge(store, {
    betareaders: {
      titlehash: { repeats: 9, kind: 'title' },
      bodyhash: { repeats: 8, kind: 'body' },
      commenthash1: { repeats: 6, kind: 'comment-body' },
      commenthash2: { repeats: 7, kind: 'comment-body' }
    }
  }, {});
  const summary = await registry.summarize(store);
  assert.deepStrictEqual(summary.bySource.betareaders, { title: 1, body: 1, 'comment-body': 2 });
  assert.strictEqual(summary.bySub.betareaders, 4, 'bySub stays a flat count — unchanged shape for existing callers');
});
