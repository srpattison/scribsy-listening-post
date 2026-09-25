'use strict';

// CB-LISTEN-REPLAY-1: bounded ID-list replay (T1–T5), the private ID builder,
// and the counts-only replay summary (T6).
//
// ALL TEXT HERE IS INVENTED. The model, store and cap are injected stubs;
// nothing leaves the process. Output directories live under os.tmpdir(),
// outside the repository.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { digest, identity } = require('../src/lib/quality-benchmark');

// Loaded tolerantly so the file runs against the predecessor SHA (where these
// exports and scripts do not exist) and each test fails on its own assertion.
const tryRequire = (p) => { try { return require(p); } catch { return {}; } };
const pilot = tryRequire('../scripts/quality-pilot');
const { summarize = () => { throw new Error('replay-summary absent'); } } = tryRequire('../scripts/replay-summary');
const { buildIdList = () => { throw new Error('replay-ids absent'); } } = tryRequire('../scripts/replay-ids');
const main = pilot.main || (async () => { throw new Error('quality-pilot main not exported'); });
const PILOT_SCRIPT = path.join(__dirname, '..', 'scripts', 'quality-pilot.js');
const SUMMARY_SCRIPT = path.join(__dirname, '..', 'scripts', 'replay-summary.js');

const emptyOutput = () => ({
  ai_related: false, stance_on_ai: 'na',
  persona: { experience: 'unknown', goal: '', goal_quote: '', goal_speaker: '' },
  stance_basis: [], stance_intensity: 0,
  comment_stance_mix: { hostile: 0, wary: 0, conflicted: 0, curious: 0, pragmatic: 0, enthusiastic: 0 },
  topics: [], pain_points: [], expected_baseline: [], deal_breakers: [], trust_signals: [],
  feature_requests: [], ethics_concerns: [], tools_mentioned: [],
  notable_quote: '', notable_quote_speaker: '', summary: ''
});

const POST = {
  subreddit: 'examplewriters', title: 'How do you all track revisions?',
  selftext: 'I am on my third revision and I lose track of which scenes I already fixed.',
  author: 'fixture_op', created_utc: 1_760_000_000, kind: 'post', source: 'reddit'
};
const HUMAN = 'My critique partners mark up a printed copy and that works better than any app I tried.';

function pilotRow(i, analysis = emptyOutput()) {
  return { partitionKey: 'examplewriters', rowKey: `p${i}`, title: `post ${i}`, analysisJson: JSON.stringify(analysis) };
}

// A frozen-pilot archive with `n` rows and a matching manifest.
function archiveOf(n = 1000) {
  const rows = Array.from({ length: n }, (_, i) => pilotRow(i));
  const ids = rows.map(identity);
  return { manifest: { pilotIds: ids, pilot: { selectionHash: digest(ids.join('\n')) } }, pilotRows: rows };
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-replay-test-'));
  const write = (name, value) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(value)); return p; };
  return { dir, write, settings: write('settings.json', []), out: path.join(dir, 'run') };
}

function stubRuntime({ raw = () => ({ post: POST, comments: [{ author: 'fixture_a', body: HUMAN }] }), output = emptyOutput } = {}) {
  const calls = { load: 0, analyzePost: 0, reserve: 0, saved: 0 };
  const loadRuntime = async () => {
    calls.load++;
    return {
      analyzePost: async () => { calls.analyzePost++; return output(); },
      getRaw: async (row) => raw(row),
      registryFor: () => new Set(),
      reserve: async () => { calls.reserve++; return true; },
      saveBlobJson: async () => { calls.saved++; }
    };
  };
  return { calls, loadRuntime };
}

const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};

// ---- T1 --------------------------------------------------------------------

test('T1: ID mode replays only the listed rows: a 3-ID list over a 1,000-row archive makes exactly 3 model calls', async () => {
  const s = scratch();
  const archive = s.write('archive.json', archiveOf(1000));
  const listed = ['examplewriters|p900', 'examplewriters|p5', 'examplewriters|p321'];
  const ids = s.write('ids.json', listed);
  const { calls, loadRuntime } = stubRuntime();
  const summary = await quiet(() => main([archive, s.settings, s.out, `--ids=${ids}`], { loadRuntime }));
  assert.strictEqual(calls.analyzePost, 3, 'stub model calls must equal the listed rows, not the 1,000-row pilot');
  assert.strictEqual(calls.reserve, 3);
  assert.deepStrictEqual({ mode: summary.mode, selected: summary.selected, processed: summary.processed }, { mode: 'ids', selected: 3, processed: 3 });
  const snap = JSON.parse(fs.readFileSync(path.join(s.out, 'pilot.private.json'), 'utf8'));
  assert.deepStrictEqual(snap.results.map((r) => r.id).sort(), [...listed].sort());
  assert.strictEqual(snap.mode, 'ids');
  assert.strictEqual(snap.idCount, 3);
  assert.strictEqual(snap.productionAnalysisWrites, 0);
});

// ---- T2 --------------------------------------------------------------------

test('T2: a list over the ceiling (default 50, only lowerable) throws before any runtime load or model call', async () => {
  const s = scratch();
  const archive = s.write('archive.json', archiveOf(1000));
  const cases = [
    { ids: Array.from({ length: 51 }, (_, i) => `examplewriters|p${i}`), flags: [], re: /ceiling is 50/ },
    { ids: ['examplewriters|p1', 'examplewriters|p2', 'examplewriters|p3'], flags: ['--max-rows=2'], re: /ceiling is 2/ },
    { ids: ['examplewriters|p1'], flags: ['--max-rows=60'], re: /may only lower/ }
  ];
  for (const [n, c] of cases.entries()) {
    const ids = s.write(`ids-${n}.json`, c.ids);
    const { calls, loadRuntime } = stubRuntime();
    await assert.rejects(main([archive, s.settings, path.join(s.dir, `out-${n}`), `--ids=${ids}`, ...c.flags], { loadRuntime }), c.re);
    assert.deepStrictEqual(calls, { load: 0, analyzePost: 0, reserve: 0, saved: 0 });
    assert.ok(!fs.existsSync(path.join(s.dir, `out-${n}`)), 'no output directory is created for a rejected list');
  }
  assert.strictEqual(pilot.ID_CEILING, 50);
  // In a fresh process, the rejection happens before any store, config, model
  // or cap module is loaded at all.
  const ids = s.write('ids-over.json', cases[0].ids);
  const probe = `
    const pilot = require(${JSON.stringify(PILOT_SCRIPT)});
    pilot.main([process.env.A, process.env.S, process.env.O, '--ids=' + process.env.I]).then(
      () => console.log(JSON.stringify({ rejected: false })),
      (e) => console.log(JSON.stringify({ rejected: /ceiling/.test(e.message),
        loaded: Object.keys(require.cache).filter((k) => /[\\\\/]src[\\\\/]lib[\\\\/](store|aoai|config|daily-cap|analysis-pipeline|boilerplate-filter)\\.js$/.test(k)).length })));`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', probe], {
    env: { ...process.env, A: archive, S: s.settings, O: path.join(s.dir, 'out-probe'), I: ids }, encoding: 'utf8'
  }).trim());
  assert.deepStrictEqual(out, { rejected: true, loaded: 0 });
});

// ---- T3 --------------------------------------------------------------------

test('T3: an ID missing from pilotRows throws before any spend and never falls back to the full pilot', async () => {
  const s = scratch();
  const archive = s.write('archive.json', archiveOf(1000));
  const ids = s.write('ids.json', ['examplewriters|p1', 'otherwriters|p1']);
  const { calls, loadRuntime } = stubRuntime();
  await assert.rejects(main([archive, s.settings, s.out, `--ids=${ids}`], { loadRuntime }), /not in archive pilotRows/);
  assert.deepStrictEqual(calls, { load: 0, analyzePost: 0, reserve: 0, saved: 0 });
  // An archive with no pilotRows at all is the same refusal, not a fallback.
  assert.throws(() => pilot.selectRows({ manifest: {} }, { ids: ['examplewriters|p1'] }), /not in archive pilotRows/);
});

// ---- T4 --------------------------------------------------------------------

test('T4: with no ID list the frozen 1,000-row check still applies and every pilot row is replayed', async () => {
  const s = scratch();
  const short = s.write('short.json', archiveOf(999));
  const stub = stubRuntime();
  await assert.rejects(main([short, s.settings, s.out], { loadRuntime: stub.loadRuntime }), /Frozen pilot manifest mismatch/);
  assert.strictEqual(stub.calls.load, 0);
  await assert.rejects(main([short, s.settings, s.out, '--max-rows=5'], { loadRuntime: stub.loadRuntime }), /only with --ids/);

  const full = s.write('full.json', archiveOf(1000));
  const { calls, loadRuntime } = stubRuntime();
  const summary = await quiet(() => main([full, s.settings, s.out], { loadRuntime }));
  assert.strictEqual(calls.analyzePost, 1000);
  assert.deepStrictEqual({ mode: summary.mode, processed: summary.processed }, { mode: 'frozen', processed: 1000 });
  const snap = JSON.parse(fs.readFileSync(path.join(s.out, 'pilot.private.json'), 'utf8'));
  assert.strictEqual(snap.selectionHash, archiveOf(1000).manifest.pilot.selectionHash);
});

// ---- T5 --------------------------------------------------------------------

test('T5: ID-mode resume is keyed to digest(ids) and rejects a different ID list', async () => {
  const s = scratch();
  const archive = s.write('archive.json', archiveOf(1000));
  const listed = ['examplewriters|p7', 'examplewriters|p3', 'examplewriters|p11'];
  const ids = s.write('ids.json', listed);
  // First run stops after one row on the cap, leaving a checkpoint to resume.
  let allow = 1;
  const first = stubRuntime();
  const capped = async () => { const rt = await first.loadRuntime(); return { ...rt, reserve: async () => allow-- > 0 }; };
  await quiet(() => main([archive, s.settings, s.out, `--ids=${ids}`], { loadRuntime: capped }));
  process.exitCode = 0;
  const snap = JSON.parse(fs.readFileSync(path.join(s.out, 'pilot.private.json'), 'utf8'));
  assert.strictEqual(snap.selectionHash, digest(listed.join('\n')));
  assert.notStrictEqual(snap.selectionHash, digest(archiveOf(1000).manifest.pilotIds.join('\n')));
  assert.strictEqual(snap.processed, 1);

  const other = s.write('other.json', ['examplewriters|p7', 'examplewriters|p3']);
  const reordered = s.write('reordered.json', [listed[1], listed[0], listed[2]]);
  for (const list of [other, reordered]) {
    const { calls, loadRuntime } = stubRuntime();
    await assert.rejects(main([archive, s.settings, s.out, `--ids=${list}`, '--resume'], { loadRuntime }), /membership mismatch/);
    assert.strictEqual(calls.load, 0);
  }
  // A frozen-mode resume against an ID-mode checkpoint is also a mismatch.
  await assert.rejects(main([archive, s.settings, s.out, '--resume'], stubRuntime()), /membership mismatch/);

  const { calls, loadRuntime } = stubRuntime();
  const summary = await quiet(() => main([archive, s.settings, s.out, `--ids=${ids}`, '--resume'], { loadRuntime }));
  assert.strictEqual(calls.analyzePost, 2, 'resume replays only the rows not yet completed');
  assert.strictEqual(summary.processed, 3);
  // The original positional form `<archive> <settings> <out> --resume` still parses.
  assert.strictEqual(pilot.parseArgs(['a', 's', 'o', '--resume']).resume, true);
});

// ---- T6 --------------------------------------------------------------------

test('T6: the replay summary prints only integers and field/enum names, never record text, identities or quotes', async () => {
  const SECRET_TITLE = 'Quillfeather Lanternmoss asks about zebra drafts';
  const SECRET_BODY = 'Marrowgate pinwheel outlines saved my sixth vellum revision entirely.';
  const SECRET_ERR = 'Obsidian heron timeout while fetching blob';
  const raw = (row) => {
    if (row.rowKey === 'p2') throw new Error(SECRET_ERR);
    if (row.rowKey === 'p3') return { post: { ...POST, author: 'AutoModerator', title: SECRET_TITLE }, comments: [] };
    return { post: { ...POST, title: SECRET_TITLE }, comments: [{ author: 'fixture_secret_user', body: SECRET_BODY }] };
  };
  const output = () => ({
    ...emptyOutput(), ai_related: true, stance_on_ai: 'curious',
    comment_stance_mix: { hostile: 0, wary: 0, conflicted: 0, curious: 1, pragmatic: 0, enthusiastic: 0 },
    feature_requests: [
      { feature: 'Marrowgate outline board', ai_related: false, basis: 'implied_need', quote: 'Marrowgate pinwheel outlines saved my sixth vellum revision', speaker: 'comment 1' },
      { feature: 'invented thing', ai_related: false, basis: 'explicit_request', quote: 'this text appears nowhere in any unit at all', speaker: 'comment 1' }
    ],
    notable_quote: SECRET_BODY, notable_quote_speaker: 'comment 1', summary: SECRET_TITLE
  });
  const old = { ...emptyOutput(), stance_on_ai: 'hostile', summary: SECRET_TITLE,
    deal_breakers: [{ item: 'x', kind: 'other', quote: 'Lanternmoss quote that is not in the source text' }] };
  const archiveObj = archiveOf(1000);
  for (const row of archiveObj.pilotRows) row.analysisJson = JSON.stringify(old);
  const s = scratch();
  const archive = s.write('archive.json', archiveObj);
  const ids = s.write('ids.json', ['examplewriters|p1', 'examplewriters|p2', 'examplewriters|p3', 'examplewriters|p4']);
  await quiet(() => main([archive, s.settings, s.out, `--ids=${ids}`], stubRuntime({ raw, output })));
  process.exitCode = 0;
  const privateFile = path.join(s.out, 'pilot.private.json');
  assert.ok(fs.readFileSync(privateFile, 'utf8').includes(SECRET_BODY), 'the synthetic private file must carry the distinctive text');

  const printed = execFileSync(process.execPath, [SUMMARY_SCRIPT, privateFile], { encoding: 'utf8' });
  for (const needle of [SECRET_TITLE, SECRET_BODY, SECRET_ERR, 'Marrowgate', 'Lanternmoss', 'fixture_secret_user', 'examplewriters|', 'p1', 'nowhere in any unit']) {
    assert.ok(!printed.includes(needle), `summary output must not contain ${needle}`);
  }
  const summary = JSON.parse(printed);
  (function walk(node, where) {
    for (const [key, value] of Object.entries(node)) {
      assert.match(key, /^[a-z0-9_.-]+(->[a-z0-9_.-]+)?$/i, `key at ${where}`);
      if (value && typeof value === 'object') walk(value, `${where}.${key}`);
      else if (typeof value === 'string') assert.match(value, /^[a-z0-9_-]+$/i, `value at ${where}.${key}`);
      else assert.ok(Number.isInteger(value), `value at ${where}.${key} must be an integer`);
    }
  })(summary, 'summary');

  assert.deepStrictEqual(summary.rows, { results: 4, compared: 2, skipped: 1, errored: 1, stopped: 0 });
  assert.deepStrictEqual(summary.skippedByReason, { 'automod-author': 1 });
  assert.deepStrictEqual(summary.stanceTransitions, { 'hostile->curious': 2 });
  assert.deepStrictEqual(summary.aiRelatedTransitions, { 'false->true': 2 });
  assert.deepStrictEqual(summary.groundingDrops, { feature_requests: 2 });
  assert.deepStrictEqual(summary.featureRequests, { old: 0, new: 2, newByBasis: { explicit_request: 0, existing_usage: 0, implied_need: 2, other: 0 } });
  assert.strictEqual(summary.quotes.old.quoteNotFound.deal_breakers, 2);
  assert.strictEqual(summary.commentStanceMix.new.curious, 2);
  assert.deepStrictEqual(summary.allListFieldsEmpty, { old: 0, new: 0 });
  // The same function is importable for in-process use.
  assert.deepStrictEqual(summarize(JSON.parse(fs.readFileSync(privateFile, 'utf8'))), summary);
});

// ---- replay-ids ------------------------------------------------------------

test('replay-ids: starter cases resolve by unique title, come first, and dedupe against judged records in report order', () => {
  const archive = { pilotRows: [
    { partitionKey: 'a', rowKey: '1', title: 'First Title' },
    { partitionKey: 'a', rowKey: '2', title: 'second title' },
    { partitionKey: 'b', rowKey: '3', title: 'Third' },
    { partitionKey: 'b', rowKey: '4', title: 'dup' },
    { partitionKey: 'b', rowKey: '5', title: 'dup' }
  ] };
  const starter = { cases: [{ source: { post: { title: '  Second Title ' } } }, { source: { post: { title: 'first title' } } }] };
  const report = { reviews: [{ id: 'b|3' }, { id: 'a|1' }, { id: 'b|3' }] };
  const built = buildIdList({ starter, report, archive });
  assert.deepStrictEqual(built.ids, ['a|2', 'a|1', 'b|3']);
  assert.deepStrictEqual(built.counts, { starterCases: 2, starterResolved: 2, starterAmbiguous: 0, starterUnmatched: 0,
    judgedDistinct: 2, starterAlsoJudged: 1, derivedIds: 3, resolvedInPilotRows: 3, unresolved: 0 });
  const bad = buildIdList({ starter: { cases: [{ source: { post: { title: 'dup' } } }, { source: { post: { title: 'nope' } } }] },
    report: { reviews: [{ id: 'z|9' }] }, archive });
  assert.deepStrictEqual([bad.counts.starterAmbiguous, bad.counts.starterUnmatched, bad.counts.unresolved], [1, 1, 3]);
});
