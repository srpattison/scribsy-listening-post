'use strict';

// CB-LISTEN-CORRECT-1 §2 — provenance stamps on every analysed row.
//
// The acceptance bar these tests hold (§7.1–7.3):
//   1. every new analysis carries all five stamp fields, versions resolved
//      from one module (lib/analysis-provenance.js);
//   2. analysisInputHash CHANGES when the assembled input changes and is
//      STABLE when it does not — a hash that does not discriminate is worse
//      than none;
//   3. the unstamped-row count in health equals rowsAnalyzed before any new
//      analysis runs, and a failed scan reads as UNAVAILABLE, never as the
//      zero that also means "fully stamped" (the REPO-3 defect).
//
// The input hash is asserted against the EXACT strings the chat client
// received (spy pattern from prompt-filter.test.js) — proving it was computed
// at the call site from what was actually sent, not re-derived from stored
// fields.

const test = require('node:test');
const assert = require('node:assert');

const provenance = require('../src/lib/analysis-provenance');
const { analyzePost, analysisPromptVersion } = require('../src/lib/aoai');
const { processAnalyzeJob } = require('../src/lib/analyze-worker');
const { createCache } = require('../src/lib/boilerplate-registry');
const cc = require('../src/lib/content-class');

const noopContext = { log() {}, warn() {}, error() {} };

const POST = {
  subreddit: 'writing',
  title: 'Does using AI for brainstorming make me a fraud?',
  selftext: 'I outlined my novel with an LLM and now I feel weird about it.',
  created_utc: 1_760_000_000,
  source: 'reddit'
};

function spyChat() {
  const seen = [];
  const chat = async (system, user) => {
    seen.push({ system, user });
    return { ai_related: true, stance_on_ai: 'conflicted', topics: [], notable_quote: '', summary: '' };
  };
  return { chat, seen, last: () => seen[seen.length - 1] };
}

// ---------------------------------------------------------------------------
// The version derivations — one module, content-derived, no copy to drift
// ---------------------------------------------------------------------------

test('registryVersionOf is order-insensitive, discriminates content, and gives the empty registry a stable value of its own', () => {
  const a = provenance.registryVersionOf(new Set(['h2', 'h1']));
  const b = provenance.registryVersionOf(['h1', 'h2']);
  assert.strictEqual(a, b, 'the same registry state must always hash the same, whatever the iteration order');
  assert.notStrictEqual(a, provenance.registryVersionOf(['h1', 'h2', 'h3']),
    'a widened registry is a DIFFERENT version — that difference is the entire point');
  assert.strictEqual(provenance.registryVersionOf(new Set()), provenance.registryVersionOf([]),
    '"filtered against nothing" is a real, stable, recordable state');
  assert.notStrictEqual(provenance.registryVersionOf(new Set()), provenance.registryVersionOf(['h1']));
});

test('filterVersion is stable across calls, and shifts when the analyze-time threshold shifts', () => {
  const v1 = provenance.filterVersion();
  const v2 = provenance.filterVersion();
  assert.strictEqual(v1, v2, 'same rule-set source + same threshold must stamp identically');

  const prev = process.env.BOILERPLATE_MIN_CHARS_BODY;
  process.env.BOILERPLATE_MIN_CHARS_BODY = '999';
  try {
    assert.notStrictEqual(provenance.filterVersion(), v1,
      'the body floor alters analyze-time filtering without a code change — the stamp must move with it');
  } finally {
    if (prev === undefined) delete process.env.BOILERPLATE_MIN_CHARS_BODY;
    else process.env.BOILERPLATE_MIN_CHARS_BODY = prev;
  }
  assert.strictEqual(provenance.filterVersion(), v1, 'restoring the threshold restores the version');
});

test('filterVersion does NOT move for registry-construction-only knobs — identical behaviour must not split into distinct versions', () => {
  // Review finding: title floor and repeat threshold shape registry
  // CONSTRUCTION only, already captured exactly by analysisRegistryVersion
  // hashing the resulting Set. Folding them here split identical analyze-time
  // behaviour into distinct filter versions.
  const v1 = provenance.filterVersion();
  const prevTitle = process.env.BOILERPLATE_MIN_CHARS_TITLE;
  const prevRepeats = process.env.BOILERPLATE_MIN_REPEATS;
  process.env.BOILERPLATE_MIN_CHARS_TITLE = '5';
  process.env.BOILERPLATE_MIN_REPEATS = '999';
  try {
    assert.strictEqual(provenance.filterVersion(), v1,
      'knobs the analyze-time filter never consults must not move its version');
  } finally {
    if (prevTitle === undefined) delete process.env.BOILERPLATE_MIN_CHARS_TITLE;
    else process.env.BOILERPLATE_MIN_CHARS_TITLE = prevTitle;
    if (prevRepeats === undefined) delete process.env.BOILERPLATE_MIN_REPEATS;
    else process.env.BOILERPLATE_MIN_REPEATS = prevRepeats;
  }
});

test('analysisPromptVersion is stable within a process and derived from the live prompt artefacts', () => {
  const v = analysisPromptVersion();
  assert.ok(/^[0-9a-f]{32}$/.test(v), `expected a 32-hex content hash, got "${v}"`);
  assert.strictEqual(analysisPromptVersion(), v);
});

// ---------------------------------------------------------------------------
// §7.2 — the input hash discriminates, and hashes what was ACTUALLY sent
// ---------------------------------------------------------------------------

test('§7.2: analysisInputHash is stable when the assembled input does not change', async () => {
  const s1 = spyChat();
  const s2 = spyChat();
  const r1 = await analyzePost(POST, [{ author: 'a', body: 'same comment' }], { chat: s1.chat });
  const r2 = await analyzePost(POST, [{ author: 'a', body: 'same comment' }], { chat: s2.chat });
  assert.ok(r1._provenance && r2._provenance, 'every analysis must carry the call-site stamp');
  assert.strictEqual(r1._provenance.analysisInputHash, r2._provenance.analysisInputHash,
    'identical assembled input must hash identically, or no query can ever group rows by input');
});

test('§7.2: analysisInputHash changes when the assembled input changes — body, and comment set alike', async () => {
  const base = (await analyzePost(POST, [], { chat: spyChat().chat }))._provenance.analysisInputHash;
  const bodyChanged = (await analyzePost({ ...POST, selftext: 'a different body entirely' }, [], { chat: spyChat().chat }))._provenance.analysisInputHash;
  const commentAdded = (await analyzePost(POST, [{ author: 'a', body: 'a comment that reached the prompt' }], { chat: spyChat().chat }))._provenance.analysisInputHash;
  assert.notStrictEqual(base, bodyChanged, 'a changed post body is a changed input');
  assert.notStrictEqual(base, commentAdded, 'a changed comment set is a changed input — this is what makes filter-scoped re-analysis expressible');
  assert.notStrictEqual(bodyChanged, commentAdded);
});

test('the input hash matches the EXACT strings the chat client received — computed at the call site, not re-derived', async () => {
  const spy = spyChat();
  const result = await analyzePost(POST, [{ author: 'a', body: 'hello there, fellow writer' }], { chat: spy.chat });
  const { system, user } = spy.last();
  assert.strictEqual(result._provenance.analysisInputHash, provenance.hashAnalysisInput(system, user),
    'the stamp must hash what was actually sent — anything else records the intention, not the fact');
});

test('the input hash covers the TRUNCATED assembly: text beyond the 6000-char body cut changes neither prompt nor hash', async () => {
  // Review finding: without this, an implementation hashing the PRE-truncation
  // assembly — recording what was intended, not what was sent — would pass.
  const longBody = 'x'.repeat(7000);
  const s1 = spyChat();
  const r1 = await analyzePost({ ...POST, selftext: longBody }, [], { chat: s1.chat });
  assert.strictEqual(r1._provenance.analysisInputHash,
    provenance.hashAnalysisInput(s1.last().system, s1.last().user),
    'a truncated prompt must be hashed as sent');

  // Vary ONLY the region the .slice(0, 6000) cut discards.
  const s2 = spyChat();
  const r2 = await analyzePost({ ...POST, selftext: longBody.slice(0, 6500) + 'DIFFERENT TAIL' }, [], { chat: s2.chat });
  assert.strictEqual(s1.last().user, s2.last().user, 'the prompts must be identical after truncation');
  assert.strictEqual(r1._provenance.analysisInputHash, r2._provenance.analysisInputHash,
    'text the model never saw must not move the input hash');

  // And varying INSIDE the kept region must move it.
  const s3 = spyChat();
  const r3 = await analyzePost({ ...POST, selftext: 'y' + longBody.slice(1) }, [], { chat: s3.chat });
  assert.notStrictEqual(r1._provenance.analysisInputHash, r3._provenance.analysisInputHash);
});

// ---------------------------------------------------------------------------
// §7.1 — all five fields land on the saved row, through the real worker path
// ---------------------------------------------------------------------------

function fakeStoreForAnalyze() {
  const saved = [];
  const aggregates = new Map();
  const fakeRow = () => {
    let stored = { value: null, etag: null };
    return {
      async get() { return { value: stored.value, etag: stored.etag }; },
      async put(next, etag) {
        if (etag !== stored.etag) { const e = new Error('etag mismatch'); e.conflict = true; throw e; }
        stored = { value: next, etag: String(Number(stored.etag || 0) + 1) };
      }
    };
  };
  return {
    saved,
    async getRaw(subreddit, createdUtc, id) {
      return {
        post: { subreddit, title: `post ${id}`, selftext: 'a body long enough to mean something', created_utc: createdUtc, kind: 'post' },
        comments: [{ author: 'AutoModerator', body: 'Please read the rules of this subreddit before posting anything at all, and include a sample of your own work with every critique request you make here.' }]
      };
    },
    async getPostRow() { return null; },
    async enqueueAnalysis() {},
    async saveAnalysis(subreddit, id, analysis, meta) { saved.push({ subreddit, id, analysis, meta }); },
    async getAggregate(p, k) { return aggregates.get(`${p}|${k}`) || null; },
    async saveAggregate(p, k, v) { aggregates.set(`${p}|${k}`, v); },
    async listAggregates() { return []; },
    aggregateBackend() { return fakeRow(); }
  };
}

test('§7.1: processAnalyzeJob stamps all five provenance fields on the saved row, versions from the one module', async () => {
  const prevCap = process.env.DAILY_ANALYZE_CAP;
  process.env.DAILY_ANALYZE_CAP = '100';
  try {
    const storeImpl = fakeStoreForAnalyze();
    const spy = spyChat();
    await processAnalyzeJob(
      { subreddit: 'writing', id: 'p1', created_utc: 1_760_000_000, kind: 'post' },
      noopContext,
      { storeImpl, chat: spy.chat, registryCache: createCache(storeImpl) }
    );

    assert.strictEqual(storeImpl.saved.length, 1);
    const { analysis, meta } = storeImpl.saved[0];
    const stamp = meta.provenanceStamp;
    assert.ok(stamp, 'the saved row must carry a provenance stamp');
    for (const field of ['analysisInputHash', 'analysisPromptVersion', 'analysisRegistryVersion', 'analysisFilterVersion', 'analysisAt', 'analysisModel']) {
      assert.ok(stamp[field], `stamp field ${field} must be present and non-empty`);
    }
    const { system, user } = spy.last();
    assert.strictEqual(stamp.analysisInputHash, provenance.hashAnalysisInput(system, user));
    assert.strictEqual(stamp.analysisPromptVersion, analysisPromptVersion());
    assert.strictEqual(stamp.analysisRegistryVersion, provenance.registryVersionOf(new Set()),
      'with no registry rows stored, the stamp records the empty-registry state that actually filtered this row');
    assert.strictEqual(stamp.analysisFilterVersion, provenance.filterVersion());
    assert.ok(!Number.isNaN(Date.parse(stamp.analysisAt)), 'analysisAt must be a real timestamp');
    assert.strictEqual(stamp.analysisModel, require('../src/lib/aoai').deploymentInForce(),
      'the deployment the call was sent to must be recorded — an AOAI_DEPLOYMENT swap is otherwise invisible');
    assert.ok(!('_provenance' in analysis), 'the stamp must never leak into analysisJson');

    // One seam deeper (review finding): the REAL entity builder writes every
    // stamp column, and the countPosts select reads the same names.
    const store = require('../src/lib/store');
    const { entity, mode } = store.analysisEntity('writing', 'p1', analysis, meta);
    assert.strictEqual(mode, 'Merge');
    for (const col of store.PROVENANCE_COLUMNS) {
      assert.ok(entity[col], `entity column ${col} must be written non-empty for a stamped analysis`);
    }
    assert.strictEqual(entity.analysisInputHash, stamp.analysisInputHash);
    assert.ok(!('_provenance' in JSON.parse(entity.analysisJson)), 'the packed analysisJson must not carry the stamp');
  } finally {
    if (prevCap === undefined) delete process.env.DAILY_ANALYZE_CAP;
    else process.env.DAILY_ANALYZE_CAP = prevCap;
  }
});

test('the registry version stamped is the version of the exact Set that filtered the row', async () => {
  const prevCap = process.env.DAILY_ANALYZE_CAP;
  process.env.DAILY_ANALYZE_CAP = '100';
  try {
    const storeImpl = fakeStoreForAnalyze();
    const hash = cc.hashIfEligible(
      'Please read the rules of this subreddit before posting anything at all, and include a sample of your own work with every critique request you make here.',
      cc.DEFAULT_MIN_CHARS
    );
    await storeImpl.saveAggregate('boilerplate-registry', 'writing', {
      subreddit: 'writing', hashes: { [hash]: { repeats: 9, kind: 'body' } }, count: 1
    });
    await processAnalyzeJob(
      { subreddit: 'writing', id: 'p2', created_utc: 1_760_000_000, kind: 'post' },
      noopContext,
      { storeImpl, chat: spyChat().chat, registryCache: createCache(storeImpl) }
    );
    const stamp = storeImpl.saved[0].meta.provenanceStamp;
    assert.strictEqual(stamp.analysisRegistryVersion, provenance.registryVersionOf(new Set([hash])),
      'the stamp must reflect the registry state in force for THIS sub at THIS call');
    assert.notStrictEqual(stamp.analysisRegistryVersion, provenance.registryVersionOf(new Set()),
      'a populated registry must stamp differently from an empty one');
  } finally {
    if (prevCap === undefined) delete process.env.DAILY_ANALYZE_CAP;
    else process.env.DAILY_ANALYZE_CAP = prevCap;
  }
});

test('a stampless or partial save CLEARS the stamp columns instead of leaving stale stamps standing under Merge', () => {
  // Review finding: saveAnalysis writes under 'Merge', so omitting the stamp
  // columns on a (defective) stampless RE-analysis would leave the previous
  // stamps standing against the new analysisJson — a stale confident answer.
  const store = require('../src/lib/store');
  const analysis = { ai_related: false, stance_on_ai: 'na', topics: [], notable_quote: '', summary: '' };

  const bare = store.analysisEntity('writing', 'p9', analysis, { provenanceStamp: null });
  for (const col of store.PROVENANCE_COLUMNS) {
    assert.strictEqual(bare.entity[col], '', `${col} must be explicitly cleared, not omitted`);
  }

  // A partial stamp missing the load-bearing input hash is treated as absent
  // entirely — never four populated version columns against an empty hash.
  const partial = store.analysisEntity('writing', 'p9', analysis, {
    provenanceStamp: { analysisPromptVersion: 'pX', analysisFilterVersion: 'fX' }
  });
  for (const col of store.PROVENANCE_COLUMNS) {
    assert.strictEqual(partial.entity[col], '', `${col} must be cleared when the stamp lacks analysisInputHash`);
  }
});

// ---------------------------------------------------------------------------
// §7.3 — the pre-stamp population, counted and REPO-3-guarded
// ---------------------------------------------------------------------------

test('§7.3: before any new analysis runs, every analysed row is unstamped — unstamped count equals rowsAnalyzed', () => {
  const tally = provenance.createProvenanceTally();
  // 100 analysed rows from the pre-provenance era: no stamp columns at all.
  for (let i = 0; i < 100; i++) tally.add({ analyzed: true });
  const out = tally.result();
  assert.strictEqual(out.unstampedAnalyzedRows, 100,
    'the correct starting value is rowsAnalyzed itself — that is history, not a bug');
  assert.strictEqual(out.stampedAnalyzedRows, 0);
  assert.deepStrictEqual(out.promptVersions, {});
});

test('stamped rows tally into distinct version values with counts — the query surface for scoped re-analysis', () => {
  const tally = provenance.createProvenanceTally();
  tally.add({ analysisInputHash: 'x1', analysisPromptVersion: 'pA', analysisRegistryVersion: 'rA', analysisFilterVersion: 'fA' });
  tally.add({ analysisInputHash: 'x2', analysisPromptVersion: 'pA', analysisRegistryVersion: 'rB', analysisFilterVersion: 'fA' });
  tally.add({ analysisInputHash: 'x3', analysisPromptVersion: 'pB', analysisRegistryVersion: 'rB', analysisFilterVersion: 'fA' });
  tally.add({ analyzed: true }); // one pre-stamp row mixed in
  const out = tally.result();
  assert.strictEqual(out.stampedAnalyzedRows, 3);
  assert.strictEqual(out.unstampedAnalyzedRows, 1);
  assert.deepStrictEqual(out.promptVersions, { pA: 2, pB: 1 });
  assert.deepStrictEqual(out.registryVersions, { rA: 1, rB: 2 });
  assert.deepStrictEqual(out.filterVersions, { fA: 3 });
});

test('the distinct-value cap is reported when hit, never silent — a per-row "version" is a defect this makes visible', () => {
  const tally = provenance.createProvenanceTally({ distinctCap: 3 });
  for (let i = 0; i < 10; i++) {
    tally.add({ analysisInputHash: `x${i}`, analysisPromptVersion: `p${i}`, analysisRegistryVersion: 'r', analysisFilterVersion: 'f' });
  }
  const out = tally.result();
  assert.strictEqual(Object.keys(out.promptVersions).length, 3);
  assert.ok(out.distinctValueOverflow, 'overflow must be reported explicitly');
  assert.strictEqual(out.distinctValueOverflow.promptVersions, 7);
  assert.strictEqual(out.distinctValueOverflow.registryVersions, 0);
});

test('REPO-3: a failed row scan surfaces as UNAVAILABLE in the health block, never as the zero that means "fully stamped"', () => {
  const failed = provenance.provenanceHealthBlock({ error: 'table scan exploded' });
  assert.strictEqual(failed.unavailable, true);
  assert.match(failed.error, /exploded/);
  assert.ok(!('unstampedAnalyzedRows' in failed), 'no count may be fabricated from a failed scan');

  const missing = provenance.provenanceHealthBlock({ total: 5, analyzed: 5 }); // scan ran but carried no provenance section
  assert.strictEqual(missing.unavailable, true);

  const ok = provenance.provenanceHealthBlock(
    { total: 5, analyzed: 5, provenance: { stampedAnalyzedRows: 0, unstampedAnalyzedRows: 5, promptVersions: {}, registryVersions: {}, filterVersions: {}, distinctValueCap: 50 } },
    { currentVersions: { analysisPromptVersion: 'pX', analysisFilterVersion: 'fX' } }
  );
  assert.strictEqual(ok.unstampedAnalyzedRows, 5);
  assert.strictEqual(ok.current.analysisPromptVersion, 'pX');
});
