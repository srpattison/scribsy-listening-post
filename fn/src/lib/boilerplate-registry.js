'use strict';

// Persisted boilerplate-hash registry (CB-LISTEN-REPO-6 §3a).
//
// Repeat-hash is REPO-5's primary detector and the only one that catches bots
// nobody enumerated — critique-thread bots, removal notices, subreddit
// submission templates with no bot author at all. But it is a corpus-level
// question ("does this text recur ≥N times in this sub"), and a single
// analyzePost invocation has no view of the sub.
//
// So the corpus-level knowledge is persisted: one aggregates row per subreddit,
// partition `boilerplate-registry`, holding the hashes that met the repeat
// threshold together with the repeat count that qualified them. The passes that
// DO see the whole corpus — retag and rollup — write it; the analyze path reads
// it.
//
// MERGE, NEVER REPLACE. Different passes see different text: rollup sees titles
// only (bodies are not in the posts table), retag sees bodies when it reads the
// raw archive, and the contamination scan sees comment bodies — the richest
// source of comment boilerplate. A pass that replaced the registry would wipe
// what the others found. Each write merges and keeps the highest repeat count
// observed.
//
// Registry misses are expected early on: a hash only enters after it has been
// seen ≥BOILERPLATE_MIN_REPEATS times. The per-row signals in comment-filter.js
// cover the gap. Nothing here computes repeat counts at analyze time.

const PARTITION = 'boilerplate-registry';

// Cap per sub so one pathological subreddit cannot bloat a row. Hashes are 16
// chars; 4000 entries is comfortably inside the chunked entity budget.
const MAX_HASHES_PER_SUB = 4000;

// Derive qualifying hashes from a content-class repeat index.
// Returns { [subreddit]: { [hash]: { repeats, kind } } }.
//
// `bodyKind` distinguishes WHICH corpus the body index was built from —
// submission bodies (retag's default, 'body') vs. comment bodies ('comment-
// body', passed by the contamination scan). Conflating the two under one
// 'body' label made "the registry has 87 hashes" unreadable as "repeat-hash
// is/isn't protecting the analyze path against comment boilerplate", because
// comment-derived and submission-derived hashes were indistinguishable once
// merged (CB-LISTEN-REPO-7 §8o).
function fromRepeatIndex(index, { minRepeats, bodyKind = 'body' } = {}) {
  const out = {};
  const harvest = (map, kind) => {
    for (const [key, repeats] of map) {
      if (repeats <= minRepeats) continue;
      const sep = key.indexOf('|');
      const sub = key.slice(0, sep);
      const hash = key.slice(sep + 1);
      (out[sub] = out[sub] || {})[hash] = { repeats, kind };
    }
  };
  harvest(index.bodies, bodyKind);
  harvest(index.titles, 'title');
  return out;
}

// Merge freshly discovered hashes into whatever is already stored.
// `discovered` is the shape returned by fromRepeatIndex.
async function merge(store, discovered, { now = () => new Date(), context } = {}) {
  const written = {};
  for (const [sub, hashes] of Object.entries(discovered || {})) {
    try {
      const prev = await store.getAggregate(PARTITION, sub);
      const existing = (prev && !prev.error && prev.hashes) || {};
      const combined = { ...existing };
      for (const [hash, meta] of Object.entries(hashes)) {
        const before = combined[hash];
        // Keep the strongest evidence seen for this hash.
        combined[hash] = (before && before.repeats >= meta.repeats) ? before : meta;
      }
      const trimmed = Object.fromEntries(
        Object.entries(combined)
          .sort((a, b) => (b[1].repeats || 0) - (a[1].repeats || 0))
          .slice(0, MAX_HASHES_PER_SUB)
      );
      await store.saveAggregate(PARTITION, sub, {
        subreddit: sub,
        hashes: trimmed,
        count: Object.keys(trimmed).length,
        updatedAt: now().toISOString()
      });
      written[sub] = Object.keys(trimmed).length;
    } catch (e) {
      // A registry write must never take down the pass that discovered it.
      context?.warn?.(`boilerplate registry write failed for ${sub}: ${e.message}`);
    }
  }
  return written;
}

// Read one subreddit's registry as a Set of hashes, for the analyze path.
async function load(store, subreddit) {
  const row = await store.getAggregate(PARTITION, String(subreddit || '').toLowerCase());
  if (!row || row.error || !row.hashes) return new Set();
  return new Set(Object.keys(row.hashes));
}

// Small TTL cache — the registry is tiny and changes slowly (only retag and the
// daily rollup write it), while the analyze queue calls this per message.
function createCache(store, { ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    async get(subreddit) {
      const key = String(subreddit || '').toLowerCase();
      const hit = entries.get(key);
      if (hit && hit.expires > now()) return hit.value;
      let value;
      try {
        value = await load(store, key);
      } catch {
        value = hit ? hit.value : new Set(); // stale beats failing the analysis
      }
      entries.set(key, { value, expires: now() + ttlMs });
      return value;
    },
    clear: () => entries.clear(),
    size: () => entries.size
  };
}

// Per-sub hash counts, for reporting. `bySource` breaks each sub's count down
// by which pass found it ('body' | 'title' | 'comment-body'), so "the registry
// has 87 hashes" can never again be misread as "repeat-hash is protecting
// comments in the analyze path" when every hash is title/submission-derived
// (§8o requirement 3).
async function summarize(store) {
  const rows = await store.listAggregates(PARTITION);
  const bySub = {};
  const bySource = {};
  let total = 0;
  for (const r of rows) {
    if (r.error) continue;
    const hashes = r.hashes || {};
    const n = r.count ?? Object.keys(hashes).length;
    bySub[r.period] = n;
    total += n;
    const sourceCounts = {};
    for (const meta of Object.values(hashes)) {
      const kind = (meta && meta.kind) || 'body';
      sourceCounts[kind] = (sourceCounts[kind] || 0) + 1;
    }
    bySource[r.period] = sourceCounts;
  }
  return { subs: Object.keys(bySub).length, hashes: total, bySub, bySource };
}

module.exports = { PARTITION, MAX_HASHES_PER_SUB, fromRepeatIndex, merge, load, createCache, summarize };
