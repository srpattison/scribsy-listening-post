'use strict';

// CB-LISTEN-REPLAY-1: counts-only before/after summary of a replay.
// Usage: node scripts/replay-summary.js <path/outside/repo/pilot.private.json>
//
// Reads a quality-pilot checkpoint and prints ONLY integers and field,
// status or enum names: no record text, no quotes, no `partitionKey|rowKey`
// identities, no error detail. Every label printed passes an allowlist; any
// other value is counted under `other`. Zero model calls, zero network.
//
// "Old" is the stored analysis on the archived row; "new" is the replayed one.
// Quote checks use quality-benchmark.checkQuotes, which locates a quote among
// the source units but does not test the speaker slot: `quoteNotFound` is a
// quote found in no unit at all. New items whose quote is not in their named
// speaker's unit are dropped by the grounding validator and appear under
// `groundingDrops` instead.

const fs = require('node:fs');
const path = require('node:path');
const { STANCES, FEATURE_BASIS } = require('../src/lib/taxonomy');
const { QUOTE_LIST_FIELDS } = require('../src/lib/grounding-validator');

const REPO = path.resolve(__dirname, '../..');
const FIELDS = new Set([...QUOTE_LIST_FIELDS, 'notable_quote', 'notable_quote_speaker', 'persona.goal', 'ai_related',
  'stance_on_ai', 'persona', 'stance_basis', 'stance_intensity', 'comment_stance_mix', 'topics', 'summary', 'grounding']);
const STATUSES = new Set(['single-origin', 'multiple-origins', 'filtered-source-only', 'not-verified', 'short-ambiguous']);
const STOP_REASONS = new Set(['daily-cap', 'five-consecutive-row-errors']);
const MIX_KEYS = STANCES.filter((s) => s !== 'na');

const pick = (set, value) => (set.has(value) ? value : 'other');
const bump = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };
const code = (value) => (typeof value === 'string' && /^[a-z0-9_-]{1,40}$/.test(value) ? value : 'other');
const stance = (value) => (value === undefined ? 'missing' : pick(new Set(STANCES), value));
const bool = (value) => (value === true ? 'true' : value === false ? 'false' : 'missing');

function tallyChecks(checks, into) {
  for (const check of Array.isArray(checks) ? checks : []) {
    const field = pick(FIELDS, check.field);
    into.byStatus[field] = into.byStatus[field] || {};
    bump(into.byStatus[field], pick(STATUSES, check.status));
    if (check.status === 'filtered-source-only') bump(into.excludedSourceOnly, field);
    if (check.status === 'not-verified') bump(into.quoteNotFound, field);
  }
}

function allListsEmpty(analysis) {
  return QUOTE_LIST_FIELDS.every((field) => !Array.isArray(analysis[field]) || analysis[field].length === 0);
}

function summarize(snapshot) {
  const out = {
    mode: pick(new Set(['ids', 'frozen']), snapshot.mode || 'frozen'),
    selected: Number(snapshot.selected) || 0,
    rows: { results: 0, compared: 0, skipped: 0, errored: 0, stopped: snapshot.stopped ? 1 : 0 },
    stoppedReason: snapshot.stopped ? pick(STOP_REASONS, snapshot.stopped) : 'none',
    skippedByReason: {},
    quotes: { old: { byStatus: {}, excludedSourceOnly: {}, quoteNotFound: {} }, new: { byStatus: {}, excludedSourceOnly: {}, quoteNotFound: {} } },
    groundingDrops: {}, groundingChecked: 0,
    stanceTransitions: {},
    commentStanceMix: { old: Object.fromEntries(MIX_KEYS.map((k) => [k, 0])), new: Object.fromEntries(MIX_KEYS.map((k) => [k, 0])) },
    aiRelatedTransitions: {},
    allListFieldsEmpty: { old: 0, new: 0 },
    featureRequests: { old: 0, new: 0, newByBasis: Object.fromEntries([...FEATURE_BASIS, 'other'].map((b) => [b, 0])) },
    changedFields: {},
    usage: {}
  };
  for (const result of Array.isArray(snapshot.results) ? snapshot.results : []) {
    out.rows.results++;
    if (result.error) { out.rows.errored++; continue; }
    if (result.skipped) {
      out.rows.skipped++;
      const reason = String(result.skipped).replace(/^excluded-post:/, '');
      bump(out.skippedByReason, code(reason));
      continue;
    }
    if (!result.analysis || !result.row) continue;
    let old;
    try { old = JSON.parse(result.row.analysisJson); } catch { old = {}; }
    const now = result.analysis;
    out.rows.compared++;
    tallyChecks(result.oldChecks, out.quotes.old);
    tallyChecks(result.newChecks, out.quotes.new);
    const grounding = now.grounding || {};
    out.groundingChecked += Number(grounding.checked) || 0;
    for (const [field, n] of Object.entries(grounding.drops || {})) bump(out.groundingDrops, pick(FIELDS, field), Number(n) || 0);
    bump(out.stanceTransitions, `${stance(old.stance_on_ai)}->${stance(now.stance_on_ai)}`);
    for (const [side, analysis] of [['old', old], ['new', now]]) {
      const mix = analysis.comment_stance_mix;
      if (mix && typeof mix === 'object') for (const key of MIX_KEYS) out.commentStanceMix[side][key] += Number(mix[key]) || 0;
      if (allListsEmpty(analysis)) out.allListFieldsEmpty[side]++;
      out.featureRequests[side] += Array.isArray(analysis.feature_requests) ? analysis.feature_requests.length : 0;
    }
    bump(out.aiRelatedTransitions, `${bool(old.ai_related)}->${bool(now.ai_related)}`);
    for (const item of Array.isArray(now.feature_requests) ? now.feature_requests : []) {
      bump(out.featureRequests.newByBasis, pick(new Set(FEATURE_BASIS), item && item.basis));
    }
    for (const field of Array.isArray(result.changedFields) ? result.changedFields : []) bump(out.changedFields, pick(FIELDS, field));
  }
  for (const key of ['requests', 'responsesWithUsage', 'promptTokens', 'completionTokens', 'totalTokens']) {
    out.usage[key] = Number(snapshot.usage && snapshot.usage[key]) || 0;
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const file = argv[0];
  if (!file) throw new Error('pilot.private.json path required');
  const relative = path.relative(REPO, path.resolve(file));
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Input must be outside repository');
  const summary = summarize(JSON.parse(fs.readFileSync(file, 'utf8')));
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  // A JSON parse error quotes the input it failed on; print a fixed line.
  try { main(); } catch { console.error('Replay summary failed; check the path is a pilot.private.json outside the repository.'); process.exitCode = 1; }
}

module.exports = { summarize, main };
