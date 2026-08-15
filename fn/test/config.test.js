'use strict';

// §9.1 — no setting may fall back to a stale copy of live configuration.
// A silent fallback to a wrong sub list is exactly the class of defect that
// produces confidently-wrong data, which is what this whole chain exists to
// eliminate. Absence must be loud.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../src/lib/config');

test('SUBREDDITS unset throws, naming the setting', () => {
  assert.throws(() => config.subreddits({}), (e) => {
    assert.strictEqual(e.name, 'ConfigError');
    assert.strictEqual(e.setting, 'SUBREDDITS');
    assert.match(e.message, /SUBREDDITS/);
    return true;
  });
  // Empty and whitespace-only are absence, not an empty corpus.
  assert.throws(() => config.subreddits({ SUBREDDITS: '' }), /SUBREDDITS/);
  assert.throws(() => config.subreddits({ SUBREDDITS: '   ' }), /SUBREDDITS/);
  assert.throws(() => config.subreddits({ SUBREDDITS: ' , , ' }), /SUBREDDITS/);
});

test('SUBREDDITS parses to a trimmed list when set', () => {
  assert.deepStrictEqual(config.subreddits({ SUBREDDITS: 'writing, writers ,nanowrimo' }),
    ['writing', 'writers', 'nanowrimo']);
});

test('SUB_TAGS unset throws rather than silently pooling enclave subs', () => {
  assert.throws(() => config.subTags({}), (e) => e.setting === 'SUB_TAGS');
  assert.throws(() => config.subTags({ SUB_TAGS: 'not json' }), /valid JSON/);
  assert.throws(() => config.subTags({ SUB_TAGS: '[]' }), /JSON object/);
  assert.deepStrictEqual(config.subTags({ SUB_TAGS: '{"a":"enclave-pro"}' }), { a: 'enclave-pro' });
});

test('BSKY_STREAMS unset throws; malformed entries are named', () => {
  assert.throws(() => config.bskyStreams({}), (e) => e.setting === 'BSKY_STREAMS');
  assert.throws(() => config.bskyStreams({ BSKY_STREAMS: '[]' }), /non-empty/);
  assert.throws(
    () => config.bskyStreams({ BSKY_STREAMS: '[{"name":"a"}]' }),
    /entry 0 needs both/
  );
  assert.throws(
    () => config.bskyStreams({ BSKY_STREAMS: '[{"name":"a","query":"q","kind":"bogus"}]' }),
    /kind "bogus"/
  );
});

test('BSKY_STREAMS carries the topic/community distinction', () => {
  const streams = config.bskyStreams({
    BSKY_STREAMS: JSON.stringify([
      { name: 'bsky-ai-slop', query: 'AI slop writing', kind: 'topic' },
      { name: 'bsky-writersky', query: '#WriterSky', kind: 'community' }
    ])
  });
  assert.deepStrictEqual(streams.map((s) => s.kind), ['topic', 'community']);
  const kinds = config.bskyStreamKinds({ BSKY_STREAMS: JSON.stringify(streams) });
  assert.strictEqual(kinds['bsky-writersky'], 'community');
});

test('comment analysis ships OFF and an unknown policy fails closed', () => {
  assert.strictEqual(config.commentAnalyzePolicy({}), 'ingest-only');
  assert.strictEqual(config.commentAnalyzePolicy({ COMMENT_ANALYZE_POLICY: 'all' }), 'all');
  // A typo must not silently widen spend.
  assert.strictEqual(config.commentAnalyzePolicy({ COMMENT_ANALYZE_POLICY: 'evrything' }), 'ingest-only');
});

test('an unset budget cap analyses nothing and says why', () => {
  const unset = config.dailyAnalyzeCap({});
  assert.strictEqual(unset.cap, 0, 'fail closed — never spend against a guessed ceiling');
  assert.match(unset.configError, /DAILY_ANALYZE_CAP/);

  const set = config.dailyAnalyzeCap({ DAILY_ANALYZE_CAP: '12000' });
  assert.strictEqual(set.cap, 12000);
  assert.strictEqual(set.configError, null);

  assert.strictEqual(config.dailyAnalyzeCap({ DAILY_ANALYZE_CAP: 'lots' }).cap, 0);
});

// ---------------------------------------------------------------------------
// Exactly one sub list may exist in the repo, and it lives in deploy.sh (§9.1).
// ---------------------------------------------------------------------------

test('the repo contains exactly one subreddit list, in deploy.sh', () => {
  const root = path.join(__dirname, '..', '..');
  const found = [];
  const skip = new Set(['.git', 'node_modules', 'test']);
  // A "sub list" = 6+ comma-separated bare words including the anchor subs.
  const LIST = /writing\s*,\s*writers\s*,\s*nanowrimo/i;

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!/\.(js|json|sh|md|html)$/.test(entry.name)) continue;
      if (LIST.test(fs.readFileSync(p, 'utf8'))) found.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  })(root);

  assert.deepStrictEqual(found, ['deploy.sh'],
    `the subreddit list must exist in exactly one place; found in: ${found.join(', ')}`);
});

test('taxonomy no longer exports a subreddit fallback', () => {
  const taxonomy = require('../src/lib/taxonomy');
  assert.strictEqual(taxonomy.DEFAULT_SUBREDDITS, undefined,
    'a second copy of live config in code is the defect, not the fix');
});
