'use strict';

// §3a/§3b — comment ingestion, the missing-`kind` read default, watermark
// namespace separation, and the analysis policy that keeps comment volume from
// blowing up spend.

const test = require('node:test');
const assert = require('node:assert');

const arctic = require('../src/lib/sources/arcticshift');
const policy = require('../src/lib/comment-policy');
const rowkeys = require('../src/lib/rowkeys');
const engine = require('../src/lib/rollup-engine');

// The exact jq expression from the brief, as a JS predicate. This is the
// measurement that defined the defect: 0 of 200 sampled rows matched it.
const COMMENT_PERMALINK = /\/comments\/[a-z0-9]+\/[^/]+\/[a-z0-9]+/;

const rawComment = (over = {}) => ({
  id: 'c1a2b3',
  subreddit: 'Writing',
  body: 'I keep a series bible so continuity does not drift. See r/worldbuilding for more.',
  author: 'someone',
  score: 4,
  created_utc: 1_760_000_100,
  link_id: 't3_p9q8r7',
  parent_id: 't3_p9q8r7',
  ...over
});

test('a normalized comment has a comment-shaped permalink', () => {
  const c = arctic.normalizeComment(rawComment({ permalink: '/r/writing/comments/p9q8r7/some_slug/c1a2b3/' }));
  assert.match(c.permalink, COMMENT_PERMALINK);
});

test('the permalink is comment-shaped even when the archive omits one', () => {
  const c = arctic.normalizeComment(rawComment()); // no permalink field
  assert.match(c.permalink, COMMENT_PERMALINK,
    'a constructed permalink must still satisfy the acceptance measurement');
});

test('a submission permalink does NOT match the comment shape', () => {
  // Guards the measurement itself: if submissions matched, the check would be
  // vacuous and would have "passed" before this round.
  const p = arctic.normalizePost({
    id: 'p9q8r7', subreddit: 'writing', title: 't', author: 'a',
    created_utc: 1_760_000_000, permalink: '/r/writing/comments/p9q8r7/some_slug/'
  });
  assert.doesNotMatch(p.permalink, COMMENT_PERMALINK);
  assert.strictEqual(p.kind, 'post');
});

test('a sampled corpus flips from zero to non-zero once comments are ingested', () => {
  const submissions = Array.from({ length: 20 }, (_, i) => arctic.normalizePost({
    id: 'p' + i, subreddit: 'writing', title: 't', author: 'a',
    created_utc: 1_760_000_000, permalink: `/r/writing/comments/p${i}/slug/`
  }));
  const before = submissions.filter((r) => COMMENT_PERMALINK.test(r.permalink)).length;
  assert.strictEqual(before, 0, 'reproduces the measured defect: submissions-only corpus');

  const withComments = [...submissions, ...Array.from({ length: 5 }, (_, i) =>
    arctic.normalizeComment(rawComment({ id: 'c' + i })))];
  const after = withComments.filter((r) => COMMENT_PERMALINK.test(r.permalink)).length;
  assert.ok(after > 0, 'the acceptance measurement must be able to flip');
  assert.strictEqual(after, 5);
});

test('comment rows carry linkId and parentId for thread reconstruction', () => {
  const topLevel = arctic.normalizeComment(rawComment({ parent_id: 't3_p9q8r7' }));
  assert.strictEqual(topLevel.linkId, 'p9q8r7');
  assert.strictEqual(topLevel.parentId, null, 'top-level comments have no parent comment');

  const reply = arctic.normalizeComment(rawComment({ id: 'c9', parent_id: 't1_c1a2b3' }));
  assert.strictEqual(reply.linkId, 'p9q8r7');
  assert.strictEqual(reply.parentId, 'c1a2b3');
});

test('comment row keys cannot collide with submission row keys', () => {
  // Reddit comment ids and submission ids are separate base-36 spaces; the same
  // string can legitimately appear in both.
  const collidingId = 'abc123';
  assert.notStrictEqual(
    rowkeys.rowKeyFor({ id: collidingId, kind: 'comment' }),
    rowkeys.rowKeyFor({ id: collidingId, kind: 'post' })
  );
  assert.strictEqual(rowkeys.rowKeyFor({ id: collidingId, kind: 'post' }), collidingId,
    'submission keys are unchanged — no migration of the existing corpus');
});

// ---------------------------------------------------------------------------
// Missing `kind` reads as `post` (§3a.2) — asserted with a fixture row that has
// no kind property at all, i.e. every row written before this round.
// ---------------------------------------------------------------------------

test('a row with no kind property reads as a submission', () => {
  const legacyRow = { partitionKey: 'writing', rowKey: 'old1', permalink: '/r/writing/comments/old1/slug/' };
  assert.ok(!('kind' in legacyRow), 'fixture must genuinely lack the property');
  assert.strictEqual(rowkeys.kindOf(legacyRow), 'post');
});

test('parseRows defaults a missing kind to post and keeps explicit comments', () => {
  const analysisJson = JSON.stringify({ ai_related: true, stance_on_ai: 'wary' });
  const { items } = engine.parseRows([
    { partitionKey: 'writing', rowKey: 'legacy', analysisJson },                       // no kind
    { partitionKey: 'writing', rowKey: 'c_new', kind: 'comment', linkId: 'p1', analysisJson }
  ]);
  assert.strictEqual(items[0].kind, 'post');
  assert.strictEqual(items[0].threadId, 'legacy', 'a submission is its own thread');
  assert.strictEqual(items[1].kind, 'comment');
  assert.strictEqual(items[1].threadId, 'p1', 'a comment groups under its submission');
});

// ---------------------------------------------------------------------------
// Analysis policy (§3b)
// ---------------------------------------------------------------------------

const short = { body: 'yeah same', bodyChars: 9, aiPrefilterHit: false };
const longAi = { body: 'x'.repeat(500), bodyChars: 500, aiPrefilterHit: true };
const longNoAi = { body: 'x'.repeat(500), bodyChars: 500, aiPrefilterHit: false };
const shortAi = { body: 'chatgpt', bodyChars: 7, aiPrefilterHit: true };

test('shipped default analyzes no comments at all', () => {
  for (const c of [short, longAi, longNoAi, shortAi]) {
    const d = policy.shouldAnalyze(c, { policy: 'ingest-only', parentAiRelated: true, minChars: 400 });
    assert.strictEqual(d.selected, false, 'ingest-only must never analyze a comment');
    assert.strictEqual(d.reason, 'ingest-only');
  }
});

test('under `policy`, the predicate is parent-AI OR (long AND mentions AI)', () => {
  const opts = { policy: 'policy', minChars: 400 };
  assert.strictEqual(policy.shouldAnalyze(short, { ...opts, parentAiRelated: true }).selected, true);
  assert.strictEqual(policy.shouldAnalyze(longAi, { ...opts, parentAiRelated: false }).selected, true);
  assert.strictEqual(policy.shouldAnalyze(longNoAi, { ...opts, parentAiRelated: false }).selected, false);
  assert.strictEqual(policy.shouldAnalyze(shortAi, { ...opts, parentAiRelated: false }).selected, false);
});

test('the dry run counts rather than estimates, and issues no analysis calls', () => {
  // The predicate short-circuits on an AI-related parent, so the "long + AI"
  // case must hang off a parent that is NOT AI-related to exercise that arm.
  const triage = [
    { linkId: 'p2', bodyChars: 500, aiPrefilterHit: true },   // long + AI      → select
    { linkId: 'p2', bodyChars: 500, aiPrefilterHit: false },  // long, no AI    → skip
    { linkId: 'p1', bodyChars: 10, aiPrefilterHit: false },   // parent is AI   → select
    { linkId: 'p3', bodyChars: 10, aiPrefilterHit: true }     // short          → skip
  ];
  const aiFlags = new Map([['p1', true], ['p2', false], ['p3', false]]);

  const out = policy.dryRun(triage, aiFlags, { minChars: 400 });

  assert.strictEqual(out.comments, 4);
  assert.strictEqual(out.wouldSelect, 2);
  assert.strictEqual(out.wouldSelectFraction, 0.5);
  assert.deepStrictEqual(out.byReason, {
    'long-and-ai-mentioning': 1, 'no-ai-mention': 1, 'parent-ai-related': 1, 'too-short': 1
  });
});

test('the dry run disagrees with a wrong guess (it is a real measurement)', () => {
  // All four qualify. A dry run that always returned the 5–10% the brief
  // guessed could not have produced this.
  const triage = Array.from({ length: 4 }, () => ({ linkId: 'p1', bodyChars: 900, aiPrefilterHit: true }));
  const out = policy.dryRun(triage, new Map([['p1', true]]), { minChars: 400 });
  assert.strictEqual(out.wouldSelectFraction, 1);
});

test('COMMENT_MIN_CHARS actually moves the selected fraction', () => {
  const triage = [
    { linkId: 'p9', bodyChars: 200, aiPrefilterHit: true },
    { linkId: 'p9', bodyChars: 600, aiPrefilterHit: true }
  ];
  const flags = new Map([['p9', false]]);
  assert.strictEqual(policy.dryRun(triage, flags, { minChars: 400 }).wouldSelect, 1);
  assert.strictEqual(policy.dryRun(triage, flags, { minChars: 100 }).wouldSelect, 2);
  assert.strictEqual(policy.dryRun(triage, flags, { minChars: 1000 }).wouldSelect, 0);
});
