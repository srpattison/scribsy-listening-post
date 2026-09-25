'use strict';

// CB-LISTEN-FIX-1: deterministic checks against STORED analysis outputs in the
// private review fixtures. Zero model calls, zero network, zero repo writes.
//
// Usage: LP_PRIVATE_DIR=/path/outside/repo node scripts/private-fixture-check.js
//
// Reads ONLY from $LP_PRIVATE_DIR. Unset or missing → prints a skip line and
// exits 0, so CI and public clones pass. Refuses to run if the directory
// resolves inside this repository. Prints COUNTS ONLY: no record text, no
// record ids, no usernames. The optional counts file goes to
// $LP_PRIVATE_DIR/out/, never to the repo.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { classifyComment, roleHintOf } = require('../src/lib/comment-filter');
const { normalizeForMatch } = require('../src/lib/grounding-validator');
const cc = require('../src/lib/content-class');
const boilerplateRegistry = require('../src/lib/boilerplate-registry');
const boilerplateFilter = require('../src/lib/boilerplate-filter');

const FILES = {
  starter: 'semantic-review-20260919-v2-starter.json',
  packet: 'semantic-review-20260919-v2-blind-packet.json',
  report: 'semantic-review-20260919-v2-report.json',
  pilot: '2026-09-18-e372b521b6ecaaee.json'
};
// SHA-256 of UTF-8 JSON.stringify(parsed), stored key order. The starter hash
// is a hard gate; the other two recording methods are unconfirmed, so both
// computed forms are printed beside them.
const RECORDED = {
  starter: '9568745f17b781eade509cae5556bf6b9417908ffd29bfab21110e43ca57f5e9',
  packet: '49bd7c9a35117cafa3193f3b18f7505c35781eb909c3d1914e69ef91ee0e8b8b',
  report: 'dfd568aa0030f8ec1631765e2b00ab1a1fa64cb6fec30a4f431a53df9e7af276'
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Fields whose stored (pre-v4) items carry a verbatim quote, and fields whose
// items are bare label strings with no quote slot.
const QUOTED_FIELDS = ['deal_breakers', 'trust_signals', 'feature_requests'];
const UNQUOTED_FIELDS = ['pain_points', 'expected_baseline', 'ethics_concerns'];

function resolvePrivateDir() {
  const dir = process.env.LP_PRIVATE_DIR;
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const real = fs.realpathSync(path.resolve(dir));
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  const rel = path.relative(repo, real);
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('LP_PRIVATE_DIR resolves inside the repository working tree; refusing to run');
  }
  return real;
}

// Units as the review packets store them: { speaker, text, distinguished,
// stickied, roleHint }. classifyComment reads body/roleHint/distinguished/
// stickied; packet speakers are masked, so author-based signals do not apply.
function packetUnits(source) {
  const toUnit = (u) => ({ body: u.text || '', roleHint: u.roleHint, distinguished: u.distinguished, stickied: u.stickied });
  const post = source.post;
  return [
    { ...toUnit(post), body: `${post.title || ''}\n${post.text || ''}`, excluded: !classifyComment(toUnit(post)).keep },
    ...(source.comments || []).map((c) => ({ ...toUnit(c), excluded: !classifyComment(toUnit(c)).keep }))
  ].map((u) => ({ norm: normalizeForMatch(u.body), excluded: u.excluded, excludedAtBaseline: baselineExcludes(u) }));
}

// Pilot archive raw records: { post: {title, selftext, author, ...}, comments: [{author, body}] }.
function rawUnits(raw) {
  const post = raw.post || {};
  const postClass = classifyComment({ ...post, body: post.selftext || '' });
  return [
    { norm: normalizeForMatch(`${post.title || ''}\n${post.selftext || ''}`), excluded: !postClass.keep, excludedAtBaseline: baselineExcludes(post) },
    ...(raw.comments || []).map((c) => ({ norm: normalizeForMatch(c.body || ''), excluded: !classifyComment(c).keep, excludedAtBaseline: baselineExcludes(c) }))
  ];
}

// The pre-model rule set on the baseline SHA (0fee3bf), for comparison:
// literal AutoModerator author, distinguished moderator, stickied. (The
// repetition-derived registry-hash needs the live registry and is not
// reproducible here.)
function baselineExcludes(u) {
  return String(u.author || '').toLowerCase() === 'automoderator' ||
    String(u.distinguished || '').toLowerCase() === 'moderator' || u.stickied === true;
}

function newTally() {
  return { outputs: 0, sourcedFromExcludedOnly: {}, notFoundInAnyKeptUnit: {}, alsoInExcludedUnit: {},
    unquotedItems: {}, quotedItems: {}, stanceMixOvercount: 0 };
}
const bump = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };

// Check one stored output against its units. Stored outputs predate the
// speaker slot, so "attributed unit" can only be tested as: found in some kept
// unit at all. A quote found only in excluded units is the T1/T2 defect; one
// found nowhere kept would fail T5 whatever speaker it named.
function checkOutput(tally, output, units) {
  if (!output || typeof output !== 'object') return;
  tally.outputs++;
  const kept = units.filter((u) => !u.excluded);
  const excluded = units.filter((u) => u.excluded);
  const check = (field, quote) => {
    const q = normalizeForMatch(quote);
    if (!q) return;
    bump(tally.quotedItems, field);
    const inKept = kept.some((u) => u.norm.includes(q));
    const inExcluded = excluded.some((u) => u.norm.includes(q));
    if (!inKept && inExcluded) bump(tally.sourcedFromExcludedOnly, field);
    if (!inKept) bump(tally.notFoundInAnyKeptUnit, field);
    if (inKept && inExcluded) bump(tally.alsoInExcludedUnit, field);
  };
  for (const field of QUOTED_FIELDS) {
    for (const item of Array.isArray(output[field]) ? output[field] : []) if (item && item.quote) check(field, item.quote);
  }
  if (output.notable_quote) check('notable_quote', output.notable_quote);
  for (const field of UNQUOTED_FIELDS) {
    const n = Array.isArray(output[field]) ? output[field].length : 0;
    if (n) bump(tally.unquotedItems, field, n);
  }
  if (output.persona && output.persona.goal) bump(tally.unquotedItems, 'persona.goal');
  // T6 on stored output: a mix totalling more than the comments that survive
  // exclusion counted units that should never have been shown.
  const keptComments = kept.length - (units[0] && !units[0].excluded ? 1 : 0);
  const mix = output.comment_stance_mix;
  if (mix && typeof mix === 'object') {
    const total = Object.values(mix).reduce((a, b) => a + (Number(b) || 0), 0);
    if (total > keptComments) tally.stanceMixOvercount++;
  }
}

function run() {
  let dir;
  try { dir = resolvePrivateDir(); } catch (e) { console.error(e.message); process.exitCode = 2; return; }
  if (!dir) { console.log('skipped: LP_PRIVATE_DIR not set'); return; }

  const read = (key) => {
    const file = path.join(dir, FILES[key]);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file);
    return { raw, json: JSON.parse(raw.toString('utf8')) };
  };

  const starter = read('starter');
  if (!starter) { console.log('skipped: starter fixture not present in LP_PRIVATE_DIR'); return; }
  const starterHash = sha256(Buffer.from(JSON.stringify(starter.json), 'utf8'));
  if (starterHash !== RECORDED.starter) {
    console.error(`STOP: starter hash mismatch (computed ${starterHash}, recorded ${RECORDED.starter})`);
    process.exitCode = 1;
    return;
  }
  const hashes = { starter: { recorded: RECORDED.starter, stringify: starterHash, rawFile: sha256(starter.raw) } };

  const packet = read('packet');
  const report = read('report');
  for (const [key, f] of [['packet', packet], ['report', report]]) {
    if (f) hashes[key] = { recorded: RECORDED[key], stringify: sha256(Buffer.from(JSON.stringify(f.json), 'utf8')), rawFile: sha256(f.raw) };
  }

  const result = { modelCalls: 0, hashes, corpora: {} };

  // Arm labels are the packets' own masked labels (A/B); arm identity is not
  // known here and not needed.
  const runCases = (name, cases) => {
    const byArm = {};
    let excludedUnits = 0, excludedAtBaseline = 0, units = 0, unavailable = 0;
    for (const c of cases) {
      if (!c || !c.source) { unavailable++; continue; }
      const u = packetUnits(c.source);
      units += u.length;
      excludedUnits += u.filter((x) => x.excluded).length;
      excludedAtBaseline += u.filter((x) => x.excludedAtBaseline).length;
      for (const [arm, output] of Object.entries(c.arms || {})) {
        byArm[arm] = byArm[arm] || newTally();
        if (!output) { bump(byArm[arm], 'missingOutput'); continue; }
        checkOutput(byArm[arm], output, u);
      }
    }
    result.corpora[name] = { cases: cases.length, unavailableSources: unavailable, units, excludedUnits, excludedAtBaseline, byArm };
  };

  runCases('starter', starter.json.cases);
  if (packet) {
    runCases('packet', packet.json.cases);
    if (report) {
      // Packet cases are in the report's queue order (caseKey NNN = queue
      // position). The judged subset is selected by position only.
      if (report.json.queueHash !== packet.json.queueHash || report.json.queue.length !== packet.json.cases.length) {
        result.corpora.judged = 'skipped: report queue does not align with packet';
      } else {
        const judged = new Set(report.json.reviews.map((r) => r.id));
        runCases('judged', packet.json.cases.filter((_, i) => judged.has(report.json.queue[i].id)));
      }
    }
  }

  const pilot = read('pilot');
  if (pilot && Array.isArray(pilot.json.review)) {
    const tally = newTally();
    let excludedUnits = 0, excludedAtBaseline = 0, units = 0, unavailable = 0;
    for (const rec of pilot.json.review) {
      let analysis;
      try { analysis = JSON.parse(rec.row.analysisJson); } catch { unavailable++; continue; }
      if (!rec.raw || !rec.raw.post) { unavailable++; continue; }
      const u = rawUnits(rec.raw);
      units += u.length;
      excludedUnits += u.filter((x) => x.excluded).length;
      excludedAtBaseline += u.filter((x) => x.excludedAtBaseline).length;
      checkOutput(tally, analysis, u);
    }
    result.corpora.pilotRaw = { records: pilot.json.review.length, unavailable, units, excludedUnits, excludedAtBaseline, stored: tally };
  }

  if (pilot && Array.isArray(pilot.json.review)) result.repetitionGuard = repetitionGuard(pilot.json, packet && packet.json);

  console.log(JSON.stringify(result, null, 2));
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'private-fixture-check.json'), JSON.stringify(result, null, 2));
}

// ---- repetition guard (CB-LISTEN-FIX-1b item 6) ----------------------------
//
// What the two repetition-derived exclusions actually remove, split by the
// derived role of the source unit: `ordinary` (no mod/bot role) versus
// `mod/bot`. An ordinary-role count is the number that matters — it is the
// only place repetition could be suppressing genuine opinion.
const roleClass = (unit) => (roleHintOf(unit) === 'ordinary-or-unknown' ? 'ordinary' : 'mod/bot');

function repetitionGuard(pilotJson, packetJson) {
  const out = {};

  // (a) Live registry, as recorded: the archive's quote checks were run with
  // the production registry (registryAvailable), and name the source unit.
  const live = { quoteMatches: { ordinary: 0, 'mod/bot': 0 }, distinctUnits: { ordinary: 0, 'mod/bot': 0 }, recordsWithRegistry: 0 };
  for (const rec of pilotJson.review || []) {
    if (!rec.raw || !Array.isArray(rec.checks)) continue;
    if (rec.registryAvailable) live.recordsWithRegistry++;
    const seen = new Set();
    for (const check of rec.checks) {
      for (const m of check.matches || []) {
        if (m.reason !== 'registry-hash') continue;
        const unit = m.origin === 'context-comment' ? (rec.raw.comments || [])[m.index] : rec.raw.post;
        const role = roleClass(unit || {});
        live.quoteMatches[role]++;
        const key = `${m.origin}|${m.index ?? 'post'}`;
        if (!seen.has(key)) { seen.add(key); live.distinctUnits[role]++; }
      }
    }
  }
  out.registryHashLiveRecorded = live;

  // (b) Registry rebuilt from the fixture units alone, with the production
  // rule (normalised body ≥ 120 chars, > 5 repeats within one subreddit).
  // The fixtures are a small slice of the corpus, so this is a floor on what
  // the corpus-wide registry would match, not an estimate of it.
  const rebuild = (units) => {
    const index = cc.buildRepeatIndex(units.map((u) => ({ subreddit: u.sub, title: '', body: u.body })));
    const reg = boilerplateRegistry.fromRepeatIndex(index, { minRepeats: cc.DEFAULT_MIN_REPEATS });
    const counts = { ordinary: 0, 'mod/bot': 0 };
    for (const u of units) {
      const hash = cc.hashIfEligible(u.body, cc.DEFAULT_MIN_CHARS);
      if (hash && reg[u.sub] && reg[u.sub][hash]) counts[roleClass(u.unit)]++;
    }
    return { units: units.length, registeredHashes: Object.values(reg).reduce((n, h) => n + Object.keys(h).length, 0), excluded: counts };
  };
  const pilotUnits = [];
  for (const rec of pilotJson.review || []) {
    if (!rec.raw) continue;
    const sub = String(rec.row && rec.row.partitionKey || '').toLowerCase();
    for (const c of rec.raw.comments || []) pilotUnits.push({ sub, body: c.body || '', unit: c });
  }
  out.registryHashRebuiltPilot = rebuild(pilotUnits);
  if (packetJson) {
    // Packet sources carry no subreddit: pooled into one bucket, which can
    // only over-count repeats (an upper bound for this slice).
    const packetUnits = [];
    for (const c of packetJson.cases || []) {
      if (!c || !c.source) continue;
      for (const u of c.source.comments || []) packetUnits.push({ sub: 'pooled', body: u.text || '', unit: { roleHint: u.roleHint } });
    }
    out.registryHashRebuiltPacketPooled = rebuild(packetUnits);
  }

  // (c) Rollup quote-recurrence (boilerplate-filter: a deal-breaker/trust quote
  // on > 5 distinct permalinks in one subreddit), over the pilot rows' stored
  // analyses. Role comes from the quote's source unit where the raw record is
  // in the archive; otherwise `no-raw`.
  const rawById = new Map((pilotJson.review || []).filter((r) => r.raw && r.row)
    .map((r) => [`${r.row.partitionKey}|${r.row.rowKey}`, r.raw]));
  const rows = [];
  for (const r of pilotJson.pilotRows || []) {
    let a; try { a = JSON.parse(r.analysisJson); } catch { continue; }
    rows.push({ key: `${r.partitionKey}|${r.rowKey}`, subreddit: r.partitionKey, permalink: r.permalink,
      dealBreakers: a.deal_breakers || [], trustSignals: a.trust_signals || [] });
  }
  const qIndex = boilerplateFilter.buildQuoteRecurrenceIndex(rows);
  const recurrence = { rows: rows.length, excludedItems: { ordinary: 0, 'mod/bot': 0, 'no-raw': 0, 'source-not-found': 0 } };
  for (const r of rows) {
    for (const item of [...r.dealBreakers, ...r.trustSignals]) {
      if (!item || !item.quote || !boilerplateFilter.isRecurringQuote(qIndex, r.subreddit, item.quote)) continue;
      const raw = rawById.get(r.key);
      if (!raw) { recurrence.excludedItems['no-raw']++; continue; }
      const q = normalizeForMatch(item.quote);
      const units = [{ ...raw.post, body: `${raw.post.title || ''}
${raw.post.selftext || ''}` }, ...(raw.comments || [])];
      const src = units.find((u) => normalizeForMatch(u.body || '').includes(q));
      recurrence.excludedItems[src ? roleClass(src) : 'source-not-found']++;
    }
  }
  out.quoteRecurrencePilot = recurrence;
  return out;
}

if (require.main === module) run();

module.exports = { resolvePrivateDir, packetUnits, rawUnits, checkOutput, newTally };
