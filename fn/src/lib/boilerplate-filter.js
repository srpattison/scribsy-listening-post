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
// Returns an excluder whose `excludeItem(row, text)` gives the exclusion
// reason for one ITEM (a deal-breaker, trust signal, baseline entry, pain
// point, ...) drawn from `row`, or null if the item should stay on the board.
function makeExcluder(registry) {
  function excludeItem(row, text) {
    if (row.stickied === true) return 'stickied';
    if (String(row.distinguished || '').toLowerCase() === 'moderator') return 'distinguished';
    if (!contentClass.isHuman(row)) return 'contentClass';
    if (isBoilerplateText(registry, row.subreddit, text)) return 'registry';
    return null;
  }
  return { excludeItem, isBoilerplateText: (sub, text) => isBoilerplateText(registry, sub, text) };
}

function newExcludedTally() {
  return { count: 0, byReason: { registry: 0, contentClass: 0, stickied: 0, distinguished: 0 } };
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
  loadRegistryForSubs, isBoilerplateText, makeExcluder, newExcludedTally, markExcluded, combineExcluded
};
