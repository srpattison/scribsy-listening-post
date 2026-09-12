'use strict';

// Item-level boilerplate/registry exclusion for the aggregation boards
// (CB-LISTEN-BOARDS-1 §4.1).
//
// Row-level exclusion (contentClass) already runs at rollup-engine.js:776-777,
// and every sentiment section already reads humanRows/humanAiRows only. This
// module is a SEPARATE, ITEM-level filter: a row classified human can still
// quote verbatim subreddit rule text inside one deal-breaker / trust-signal /
// baseline / pain-point entry, and that one item must not reach a board even
// though the row it came from is otherwise a genuine human post.
//
// Reuses content-class.js's normalise/hash (hashIfEligible) so a text that
// matched the registry at write time (retag / rollup title-harvest) matches
// here too — a second normaliser would silently miss everything the registry
// recorded.
//
// Dependency-avoidance note (RP-D1-HARVEST-1): boilerplateRegistry.load()
// already returns a flat Set of hashes for a subreddit with no `kind` — it
// never distinguishes 'body' / 'comment-body' / 'title'. This module never
// reads `kind` at all, so it does not depend on merge()'s kind-discarding
// defect being fixed.

const contentClass = require('./content-class');
const boilerplateRegistry = require('./boilerplate-registry');

// ---------------------------------------------------------------------------
// S1 (CB-LISTEN-BOARDS-2 §3) — item-level exclusion by QUOTE recurrence.
//
// ROOT CAUSE this repairs: the registry indexes whole bodies/titles, but the
// analyzer emits a sentence-level quote extracted FROM a body — hash(sentence)
// never equals hash(body), at any floor (§2). A quote that recurs verbatim
// across many distinct permalinks within one subreddit is boilerplate on its
// own evidence, independent of the registry and immune to which body it was
// pasted into.
//
// APPLIES TO QUOTES ONLY, NEVER LABELS. A board entry's `count` is an
// aggregation key by construction (e.g. "content warnings": 363 is 363
// legitimate posts sharing a label, not 363 repeats of one string). Only
// deal_breakers[].quote and trust_signals[].quote are genuine verbatim quotes
// distinct from their aggregation key (item / signal); expected_baseline and
// pain_points carry no separate quote field — the string IS the label, so
// recurrence-checking it would suppress real shared writer sentiment. That
// gap (minbar.baselineCounts) is out of scope for this round (brief §4).
//
// Threshold reuses the existing repeat-hash convention (content-class.js's
// DEFAULT_MIN_REPEATS / boilerplateMinRepeats): more than N distinct
// permalinks carrying the identical normalised quote, within one subreddit.
// The live measurement this round fixes (661 occurrences of one sentence) is
// nowhere near this line — recurrence is the whole of the evidence, not a
// tuning question. A modest character floor (well below the 120-char body
// floor, which would exclude nearly every ~55-char extracted quote and repeat
// the original defect) still guards against hashing pathologically short
// fragments.
const DEFAULT_MIN_QUOTE_CHARS = 20;
const DEFAULT_MIN_QUOTE_REPEATS = 5;

// Quote-bearing item arrays only — see the note above on why baseline/pain
// points are excluded.
function extractQuotes(row) {
  const out = [];
  for (const d of row.dealBreakers || []) if (d && d.quote) out.push(d.quote);
  for (const t of row.trustSignals || []) if (t && t.quote) out.push(t.quote);
  return out;
}

// Map `${subreddit}|${quoteHash}` -> count of DISTINCT permalinks carrying
// that quote. Distinct permalinks, not raw occurrences, so one prolific author
// repeating themselves once is not mistaken for many writers agreeing.
function buildQuoteRecurrenceIndex(rows, { minQuoteChars = DEFAULT_MIN_QUOTE_CHARS } = {}) {
  const bySubQuote = new Map();
  for (const r of rows || []) {
    const sub = String(r.subreddit || '').toLowerCase();
    for (const q of extractQuotes(r)) {
      const hash = contentClass.hashIfEligible(q, minQuoteChars);
      if (!hash) continue;
      const key = `${sub}|${hash}`;
      const set = bySubQuote.get(key) || new Set();
      set.add(r.permalink || r.id);
      bySubQuote.set(key, set);
    }
  }
  const counts = new Map();
  for (const [key, set] of bySubQuote) counts.set(key, set.size);
  return counts;
}

// Pure check against a precomputed index (see buildQuoteRecurrenceIndex).
function isRecurringQuote(index, sub, quote, {
  minQuoteChars = DEFAULT_MIN_QUOTE_CHARS,
  minQuoteRepeats = DEFAULT_MIN_QUOTE_REPEATS
} = {}) {
  if (!quote || !index) return false;
  const hash = contentClass.hashIfEligible(quote, minQuoteChars);
  if (!hash) return false;
  const key = `${String(sub || '').toLowerCase()}|${hash}`;
  return (index.get(key) || 0) > minQuoteRepeats;
}

// Preload one Set-of-hashes per subreddit actually present in the corpus, so
// the (currently synchronous) board builders can check membership without
// making the rollup's section list async end-to-end.
async function loadRegistryForSubs(store, subreddits) {
  const registry = new Map();
  for (const raw of new Set(subreddits || [])) {
    const sub = String(raw || '').toLowerCase();
    if (!sub || registry.has(sub)) continue;
    registry.set(sub, await boilerplateRegistry.load(store, sub));
  }
  return registry;
}

// Pure check: does `text` hash to something the registry recorded for `sub`?
// Takes the registry explicitly (rather than closing over module state) so it
// stays unit-testable with a hand-built Map in isolation from any store.
function isBoilerplateText(registry, sub, text) {
  const set = registry && registry.get ? registry.get(String(sub || '').toLowerCase()) : null;
  if (!set || !set.size) return false;
  const hash = contentClass.hashIfEligible(text);
  return !!(hash && set.has(hash));
}

// registry: Map<subreddit(lowercase), Set<hash>> — e.g. from loadRegistryForSubs.
// opts.quoteIndex: Map from buildQuoteRecurrenceIndex, or null/undefined to
// disable the S1 recurrence rung entirely (e.g. while it is being built).
// Returns an excluder whose `excludeItem(row, text, { quote })` gives the
// exclusion reason for one ITEM (a deal-breaker, trust signal, baseline entry,
// pain point, ...) drawn from `row`, or null if the item should stay on the
// board. `quote` is the item's own verbatim quote field, passed ONLY by
// callers whose item actually carries one distinct from its aggregation label
// (deal-breakers, trust signals) — see the S1 note above `extractQuotes`.
function makeExcluder(registry, opts = {}) {
  const { quoteIndex = null, minQuoteChars, minQuoteRepeats } = opts;
  function excludeItem(row, text, { quote } = {}) {
    if (row.stickied === true) return 'stickied';
    if (String(row.distinguished || '').toLowerCase() === 'moderator') return 'distinguished';
    if (!contentClass.isHuman(row)) return 'contentClass';
    if (isBoilerplateText(registry, row.subreddit, text)) return 'registry';
    if (quoteIndex && isRecurringQuote(quoteIndex, row.subreddit, quote, { minQuoteChars, minQuoteRepeats })) {
      return 'quote-recurrence';
    }
    return null;
  }
  return { excludeItem, isBoilerplateText: (sub, text) => isBoilerplateText(registry, sub, text) };
}

function newExcludedTally() {
  return { count: 0, byReason: { registry: 0, 'quote-recurrence': 0, contentClass: 0, stickied: 0, distinguished: 0 } };
}

function markExcluded(tally, reason) {
  tally.count++;
  tally.byReason[reason] = (tally.byReason[reason] || 0) + 1;
}

// Merge several section-level excluded tallies into one (e.g. for the
// strategy-brief evidence pack, which draws on minbar + trust + distributions).
function combineExcluded(tallies) {
  const out = newExcludedTally();
  for (const t of tallies || []) {
    if (!t) continue;
    out.count += t.count || 0;
    for (const [k, v] of Object.entries(t.byReason || {})) out.byReason[k] = (out.byReason[k] || 0) + v;
  }
  return out;
}

module.exports = {
  loadRegistryForSubs, isBoilerplateText, makeExcluder, newExcludedTally, markExcluded, combineExcluded,
  buildQuoteRecurrenceIndex, isRecurringQuote, extractQuotes,
  DEFAULT_MIN_QUOTE_CHARS, DEFAULT_MIN_QUOTE_REPEATS
};
