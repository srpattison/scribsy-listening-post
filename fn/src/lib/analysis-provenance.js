'use strict';

// Provenance stamps for analysed rows (CB-LISTEN-CORRECT-1 §2).
//
// WHY: no analysed row records which prompt, boilerplate-registry state, or
// classifier rule-set produced it, so "re-analyse only the rows affected by X"
// is not expressible and the only expressible remediation is "all of them".
// These stamps make every future fix a QUERY over version values followed by a
// re-analysis of exactly the named rows — never the corpus again.
//
// EVERY version here is DERIVED FROM THE LIVE THING IT STAMPS, at stamp time,
// in this one module. That is the anti-drift requirement: a hand-bumped
// integer can update the behaviour and leave the stamp reading the old value,
// which converts an unknown into a confident wrong answer — the exact shape
// (a stale preflight copy reporting success) this program has already paid
// for. A content-derived version cannot drift because there is no second copy
// to go stale.
//
// The stamp fields (written by store.saveAnalysis, from analyze-worker):
//   analysisPromptVersion   — hash of the live system prompt + response schema
//                             + the prompt-assembly code itself (aoai.js
//                             computes it via promptVersionFrom, from the
//                             values in force at the call).
//   analysisRegistryVersion — hash of the exact boilerplate-hash Set consulted
//                             for THIS row's prompt filtering (per-sub, live).
//   analysisFilterVersion   — hash of the bot/boilerplate classifier rule-set
//                             SOURCE (content-class.js + comment-filter.js)
//                             plus the analyze-time body floor in force, the
//                             one env-tunable threshold that changes filtering
//                             behaviour without a code change.
//   analysisInputHash       — hash of the EXACT prompt strings sent to the
//                             model, computed at the call site in
//                             aoai.analyzePost AFTER all assembly — never
//                             re-derived later from stored fields, which would
//                             reproduce the assumption instead of recording
//                             the fact.
//   analysisAt              — ISO timestamp taken when the model call is made.
//   analysisModel           — the deployment name the call was sent to
//                             (review finding: without it, an AOAI_DEPLOYMENT
//                             swap changes behaviour with every other stamp
//                             identical, and "re-analyse rows produced by the
//                             old model" is inexpressible). Residual: Azure
//                             can update the model BEHIND a deployment name;
//                             that channel is not client-observable here.
//
// Existing rows have no stamps and are NEVER back-filled with guesses: an
// absent stamp means "analysed before provenance existed" and is itself
// information. The pre-stamp population is surfaced (and watched shrinking)
// via /api/insights?view=health — see createProvenanceTally below.

const crypto = require('node:crypto');
const fs = require('node:fs');

// 32 hex chars of SHA-256: opaque, compact enough for a Table column, and far
// beyond collision reach at this corpus scale (2^128 space).
const hash32 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);

// NUL joiner so ("ab","c") can never collide with ("a","bc").
const joinParts = (...parts) => parts.join('\u0000');

// --- analysisInputHash -------------------------------------------------------

// Hash of the exact strings handed to the chat client — the system prompt and
// the fully assembled user prompt. Called by aoai.analyzePost at the moment of
// the model call, with the same variables it passes to `chat`.
function hashAnalysisInput(system, user) {
  return hash32(joinParts(String(system), String(user)));
}

// --- analysisPromptVersion ---------------------------------------------------

// Derive a prompt version from the live prompt artefacts: the system prompt
// string, the JSON response schema, and the source of the assembly function
// itself (Function.prototype.toString of the live function — so a change to
// the user-prompt template bumps the version even though the system prompt is
// untouched). The caller (aoai.js) passes its own live values; this module
// only defines the derivation, so there is exactly one place the rule lives
// and no copy to drift.
function promptVersionFrom({ system, schema, assembly }) {
  return hash32(joinParts(
    String(system),
    JSON.stringify(schema),
    typeof assembly === 'function' ? assembly.toString() : String(assembly || '')
  ));
}

// --- analysisRegistryVersion -------------------------------------------------

// Content hash of a boilerplate-registry state — the Set of hashes actually
// consulted for a row. Order-insensitive (sorted before hashing) so two reads
// of the same registry always agree. An empty registry hashes to a stable
// value of its own: "filtered against nothing" is a real, recordable state.
function registryVersionOf(hashes) {
  const list = [...(hashes || [])].map(String).sort();
  return hash32(list.join('\u0000')); // NUL, not ',' — registry hashes are hex today, but boundaries must not depend on that
}

// --- analysisFilterVersion ---------------------------------------------------

// The classifier rule-set is code (content-class.js defines the detectors,
// comment-filter.js applies them at analyze time), so its version is a hash of
// that source, read from disk once per process. The one env-tunable threshold
// the ANALYZE-TIME filter consults - the body floor - is folded in at stamp
// time because it changes filtering behaviour without a code change.
//
// Deliberately NOT folded in (review finding): BOILERPLATE_MIN_CHARS_TITLE and
// BOILERPLATE_MIN_REPEATS shape registry CONSTRUCTION only, which
// analysisRegistryVersion already captures exactly by hashing the resulting
// Set - including them here split identical analyze-time behaviour into
// distinct version values (probe-confirmed: filterComments output was
// bit-identical across those knob changes while the version moved).
let filterSourceHashMemo = null;
function filterSourceHash() {
  if (filterSourceHashMemo) return filterSourceHashMemo;
  const files = [require.resolve('./content-class'), require.resolve('./comment-filter')];
  const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\u0000');
  filterSourceHashMemo = hash32(src);
  return filterSourceHashMemo;
}

function filterVersion({ config = require('./config') } = {}) {
  return hash32(joinParts(
    filterSourceHash(),
    JSON.stringify({ minCharsBody: config.boilerplateMinCharsBody() })
  ));
}

// --- health surface (CB-LISTEN-CORRECT-1 §6) --------------------------------

// Cap on DISTINCT version values tracked per field. Distinct values should
// number a handful; hundreds would mean a version derivation is accidentally
// per-row, and the overflow counter below is what makes that defect VISIBLE
// instead of letting it bloat the health payload — reported, never silent.
const DISTINCT_VERSION_CAP = 50;

// Accumulates provenance tallies over one pass of the posts table (used by
// store.countPosts so health needs no second full scan). Pure and offline-
// testable: `add` takes any row-shaped object bearing the stamp columns.
function createProvenanceTally({ distinctCap = DISTINCT_VERSION_CAP } = {}) {
  const fields = {
    promptVersions: new Map(),
    registryVersions: new Map(),
    filterVersions: new Map(),
    modelVersions: new Map()
  };
  const overflow = { promptVersions: 0, registryVersions: 0, filterVersions: 0, modelVersions: 0 };
  let stamped = 0;
  let unstamped = 0;

  const bump = (name, value) => {
    const m = fields[name];
    if (m.has(value)) { m.set(value, m.get(value) + 1); return; }
    if (m.size >= distinctCap) { overflow[name]++; return; }
    m.set(value, 1);
  };

  return {
    add(row) {
      // Unstamped = missing the input hash, the load-bearing field. Rows are
      // stamped atomically (one write path), so this is also "missing all".
      if (!row.analysisInputHash) { unstamped++; return; }
      stamped++;
      bump('promptVersions', String(row.analysisPromptVersion || '(absent)'));
      bump('registryVersions', String(row.analysisRegistryVersion || '(absent)'));
      bump('filterVersions', String(row.analysisFilterVersion || '(absent)'));
      bump('modelVersions', String(row.analysisModel || '(absent)'));
    },
    result() {
      const out = {
        stampedAnalyzedRows: stamped,
        unstampedAnalyzedRows: unstamped,
        promptVersions: Object.fromEntries(fields.promptVersions),
        registryVersions: Object.fromEntries(fields.registryVersions),
        filterVersions: Object.fromEntries(fields.filterVersions),
        modelVersions: Object.fromEntries(fields.modelVersions),
        distinctValueCap: distinctCap
      };
      if (overflow.promptVersions || overflow.registryVersions || overflow.filterVersions || overflow.modelVersions) {
        // Rows whose value could not be tracked once the cap was reached —
        // a non-zero here is itself a finding (a per-row "version").
        out.distinctValueOverflow = overflow;
      }
      return out;
    }
  };
}

// Build the health `provenance` block from countPosts' result. REPO-3 pattern:
// a scan failure must surface as an explicit unavailable state — zero is also
// the value that means "fully stamped", so an exception rendering as zero
// would read as complete success.
function provenanceHealthBlock(counts, { currentVersions = null } = {}) {
  if (!counts || counts.error) {
    return { unavailable: true, error: (counts && counts.error) || 'row scan returned nothing' };
  }
  if (!counts.provenance) {
    return { unavailable: true, error: 'row scan did not include provenance columns' };
  }
  return {
    ...counts.provenance,
    current: currentVersions,
    note: 'unstampedAnalyzedRows = analysed before provenance stamps existed (CB-LISTEN-CORRECT-1); expected to equal rowsAnalyzed until new analysis runs, then to hold steady while stamped grows'
  };
}

module.exports = {
  hashAnalysisInput,
  promptVersionFrom,
  registryVersionOf,
  filterVersion,
  createProvenanceTally,
  provenanceHealthBlock,
  DISTINCT_VERSION_CAP
};
