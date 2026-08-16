'use strict';

// Corpus quality audit (CB-LISTEN-REPO-6 §8, adopted by CB-LISTEN-REPO-7 §1).
//
// "What else is contaminating this corpus?" — answered in counts, before
// ~$400-600 is spent analysing the remaining ~153,792 rows. ZERO MODEL CALLS:
// every check here is computable from the `posts` table plus `raw` blobs.
//
// Two passes, split by cost exactly the way retag.js already splits
// runRetag (table-only) from scanContamination (blob-reading):
//
//   tableChecks(rows, opts)   — §8b, §8f, §8g, §8h, §8i, plus §8e's flair
//                               distribution and 30-row sample. A single full
//                               table scan, no blob reads — proven fast by
//                               runRetag (16.6s over 219,190 rows).
//   scanChunk({...})          — §8a, §8c, §8d, §8e's body-length distribution,
//                               §8j. Reads one bounded chunk of `raw` blobs,
//                               resumable via `after`, exactly like
//                               scanContamination. The caller (functions/
//                               audit.js's queue worker) merges each chunk's
//                               LOCAL findings into a persisted running
//                               accumulator with mergeChunk() — a single
//                               invocation's findings are not the corpus, the
//                               merged accumulator is.

const cc = require('./content-class');
const { classifyComment } = require('./comment-filter');
const { kindOf, idFromRowKey } = require('./rowkeys');

// §8d: "under a minimum length" — stated explicitly per the brief's own
// instruction to report the threshold used. Distinct from content-class.js's
// DEFAULT_MIN_CHARS (120), which is a boilerplate-repetition floor, not an
// emptiness floor; 20 chars is long enough to rule out "ok", "thanks!" etc.
// while still catching near-empty rows.
const EMPTY_MIN_CHARS = 20;
const REMOVED_MARKERS = new Set(['[removed]', '[deleted]']);

// §8a: a "match" below this length is coincidence, not provenance — same
// reasoning and same value as retag.js's contamination scan (QUOTE_MIN_CHARS).
const QUOTE_MIN_CHARS = 25;

// r2 fix — the incident this constant exists to prevent: quoteSamples was
// capped at 20 total (not per partition), first-come-first-served. At 254,035
// rows that is bounded in COUNT but was still ~93% of the accumulator's
// serialized size after only 4,000 rows once combined with everything else,
// and it grows toward that 20-item ceiling from the very first partition
// scanned — nothing about "20 total" bounds it by PARTITION, so a corpus with
// many subreddits still produces a lopsided, non-representative sample. Now
// bounded per (subreddit, bucket) via reservoir sampling (Algorithm R), so
// total accumulator size from this field is O(partitions), not O(rows), and
// every partition gets a fair, unbiased sample regardless of scan order.
const QUOTE_SAMPLE_CAP_PER_PARTITION = 5;

// §8c: crosspost/repost hashing floor. Reuses content-class's body floor
// (120 chars) rather than inventing a new threshold — the same false-positive
// reasoning applies: short bodies genuinely recur between unrelated posts.
const DUP_MIN_CHARS = cc.DEFAULT_MIN_CHARS;

// Hard cap on distinct body hashes tracked for duplicate detection across the
// whole corpus. Not a per-sub cap like boilerplate-registry's (duplicates are
// cross-sub by definition) — a corpus-wide one. Chosen so the accumulator
// stays well inside a sane aggregates-row size; logged explicitly if hit
// rather than silently dropping detection (§8c's own "no silent caps" bar).
const MAX_TRACKED_HASHES = 20000;

// Subs the brief names explicitly as near-entirely or substantially fiction.
const FICTION_HEAVY_SUBS = new Set(['destructivereaders', 'betareaders', 'writing', 'fictionwriting']);
const CRITIQUE_FLAIRS = ['critique', 'excerpt', 'feedback', 'sharing'];

function isCritiqueFlaired(flair) {
  const f = String(flair || '').toLowerCase();
  return CRITIQUE_FLAIRS.some((c) => f.includes(c));
}

// §8j: a CHEAP heuristic, stated plainly rather than a real language
// detector — this system's prompts and schema assume English idiom, so the
// question is "does this read as English at all", not "which language".
// Text counts as English-looking if at least 2 of a small common-stopword set
// appear in its first 200 normalised characters, for any text long enough
// to make that meaningful (≥40 chars). Shorter text is not flagged either way
// — too little signal to call it.
const ENGLISH_STOPWORDS = ['the', 'and', 'is', 'to', 'of', 'a', 'in', 'that', 'it', 'for', 'on', 'with', 'as', 'was', 'but', 'are', 'this', 'have', 'be', 'i'];
function looksNonEnglish(text) {
  const n = cc.normalizeText(text);
  if (n.length < 40) return false; // too short to judge either way
  const window = ` ${n.slice(0, 200)} `;
  const hits = ENGLISH_STOPWORDS.filter((w) => window.includes(` ${w} `)).length;
  return hits < 2;
}

function isEmptyOrRemoved(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (REMOVED_MARKERS.has(t.toLowerCase())) return true;
  return t.length < EMPTY_MIN_CHARS;
}

// ---------------------------------------------------------------------------
// §8a — quote provenance and fidelity
// ---------------------------------------------------------------------------

// Every verbatim-quote field in the analysis schema, as a getter over a
// parsed analysisJson object.
function quoteFieldsOf(analysis) {
  if (!analysis || typeof analysis !== 'object') return [];
  const out = [];
  if (analysis.notable_quote) out.push({ field: 'notable_quote', quote: analysis.notable_quote });
  for (const [field, key] of [['deal_breakers', 'quote'], ['trust_signals', 'quote'], ['feature_requests', 'quote']]) {
    for (const item of analysis[field] || []) {
      if (item && item[key]) out.push({ field, quote: item[key] });
    }
  }
  return out;
}

// Classify one quote against its own row's source text. `humanBodies` /
// `botBodies` are arrays of RAW (not yet normalised) comment bodies, already
// split by classifyComment (§8a reuses the exact same bot/boilerplate
// detector the analyze-time filter uses — a quote lifted from a comment the
// filter would now catch is 'bot-comment' regardless of when it was analysed).
function classifyQuote(quote, { postText, humanBodies = [], botBodies = [] }) {
  const nq = cc.normalizeText(quote);
  if (nq.length < QUOTE_MIN_CHARS) return null; // too short to attribute either way
  if (cc.normalizeText(postText).includes(nq)) return 'post-body';
  if (humanBodies.some((b) => cc.normalizeText(b).includes(nq))) return 'human-comment';
  if (botBodies.some((b) => cc.normalizeText(b).includes(nq))) return 'bot-comment';
  return 'not-found';
}

// ---------------------------------------------------------------------------
// §8b, §8f, §8g, §8h, §8i, §8e(part) — the table-only pass
// ---------------------------------------------------------------------------

// `rows` need { partitionKey (subreddit), author, analyzed, aiRelated, stance,
// contentClass, contentClassReason, week, flair, permalink, kind }.
function tableChecks(rows, { subTags = {} } = {}) {
  const analyzed = (rows || []).filter((r) => r.analyzed === true);

  // §8b — author concentration.
  const byAuthor = new Map();
  for (const r of analyzed) {
    const author = String(r.author || '[unknown]');
    const a = byAuthor.get(author) || { author, posts: 0, aiRelated: 0, subs: new Set() };
    a.posts++;
    if (r.aiRelated) a.aiRelated++;
    a.subs.add(r.partitionKey);
    byAuthor.set(author, a);
  }
  const authorsSorted = [...byAuthor.values()].sort((x, y) => y.aiRelated - x.aiRelated || y.posts - x.posts);
  const totalAiRelated = analyzed.filter((r) => r.aiRelated).length;
  const shareOfTop = (n) => {
    const cut = Math.max(1, Math.ceil(authorsSorted.length * n));
    const top = authorsSorted.slice(0, cut);
    const sum = top.reduce((s, a) => s + a.aiRelated, 0);
    return totalAiRelated ? sum / totalAiRelated : 0;
  };
  const authorConcentration = {
    totalAuthors: byAuthor.size,
    totalAiRelated,
    top1PctShare: shareOfTop(0.01),
    top10PctShare: shareOfTop(0.10),
    top20: authorsSorted.slice(0, 20).map((a) => ({
      author: a.author, aiRelatedPosts: a.aiRelated, totalPosts: a.posts, subs: [...a.subs]
    }))
  };

  // §8f — sub concentration among AI-related rows, enclave vs population.
  const bySub = new Map();
  for (const r of analyzed) {
    if (!r.aiRelated) continue;
    const sub = r.partitionKey;
    bySub.set(sub, (bySub.get(sub) || 0) + 1);
  }
  let enclaveTotal = 0, populationTotal = 0;
  const bySubOut = {};
  for (const [sub, n] of bySub) {
    const tag = subTags[sub] || 'population';
    bySubOut[sub] = { count: n, tag };
    if (tag === 'enclave') enclaveTotal += n; else populationTotal += n;
  }
  const subConcentration = {
    totalAiRelated,
    enclaveShare: totalAiRelated ? enclaveTotal / totalAiRelated : 0,
    populationShare: totalAiRelated ? populationTotal / totalAiRelated : 0,
    bySub: bySubOut
  };

  // §8g — temporal concentration.
  const byWeek = new Map();
  for (const r of analyzed) {
    if (!r.aiRelated || !r.week) continue;
    byWeek.set(r.week, (byWeek.get(r.week) || 0) + 1);
  }
  const weekCounts = [...byWeek.values()].sort((a, b) => a - b);
  const median = weekCounts.length
    ? (weekCounts.length % 2 ? weekCounts[(weekCounts.length - 1) / 2]
      : (weekCounts[weekCounts.length / 2 - 1] + weekCounts[weekCounts.length / 2]) / 2)
    : 0;
  const spikeThreshold = median * 3;
  const spikes = [...byWeek.entries()]
    .filter(([, n]) => median > 0 && n > spikeThreshold)
    .map(([week, n]) => ({ week, count: n, medianMultiple: median ? n / median : null }))
    .sort((a, b) => b.count - a.count);
  // Stray pre-2019 rows the brief calls out explicitly.
  const strayWeeks = [...byWeek.entries()]
    .filter(([week]) => week < '2019-W01')
    .map(([week, n]) => ({ week, count: n }));
  const temporal = { median, spikeThreshold, spikes, strayWeeks, weeksCovered: byWeek.size };

  // §8h — stance / aiRelated coherence.
  let strongStanceNotAiRelated = 0, aiRelatedNoStance = 0;
  for (const r of analyzed) {
    const hasStrongStance = r.stance && r.stance !== 'na';
    if (hasStrongStance && !r.aiRelated) strongStanceNotAiRelated++;
    if (r.aiRelated && (!r.stance || r.stance === 'na')) aiRelatedNoStance++;
  }
  const stanceCoherence = { strongStanceNotAiRelated, aiRelatedNoStance, totalAnalyzed: analyzed.length };

  // §8i — bot-detection coverage, the meta-check. Zero detections in a sub
  // that completed a full walk is a red flag, not a clean result — flagged
  // here, left for the caller/report reader to cross-reference against §8m's
  // submission-vs-comment-boilerplate distinction.
  const bySubClass = {};
  for (const r of rows || []) {
    const sub = r.partitionKey;
    const b = bySubClass[sub] || { total: 0, bot: 0, boilerplate: 0, human: 0, byReason: {} };
    b.total++;
    const cls = r.contentClass || 'human';
    b[cls] = (b[cls] || 0) + 1;
    if (cls !== 'human' && r.contentClassReason) {
      b.byReason[r.contentClassReason] = (b.byReason[r.contentClassReason] || 0) + 1;
    }
    bySubClass[sub] = b;
  }
  const zeroDetectionSubs = Object.entries(bySubClass)
    .filter(([, b]) => b.total > 0 && b.bot === 0 && b.boilerplate === 0)
    .map(([sub]) => sub);
  const botDetectionCoverage = { bySub: bySubClass, zeroDetectionSubs };

  // §8e (table-only part) — flair distribution + 30-row critique sample.
  const flairBySub = {};
  const critiqueCandidates = [];
  for (const r of analyzed) {
    const sub = r.partitionKey;
    const flairCounts = flairBySub[sub] || (flairBySub[sub] = {});
    const flair = r.flair || '(none)';
    flairCounts[flair] = (flairCounts[flair] || 0) + 1;
    if (FICTION_HEAVY_SUBS.has(String(sub).toLowerCase()) || isCritiqueFlaired(r.flair)) {
      critiqueCandidates.push({
        subreddit: sub, permalink: r.permalink || null, flair: r.flair || '',
        stanceOnAi: r.stance || 'na'
      });
    }
  }
  const fictionSample = critiqueCandidates.slice(0, 30);

  return { authorConcentration, subConcentration, temporal, stanceCoherence, botDetectionCoverage, flairBySub, fictionSample };
}

// ---------------------------------------------------------------------------
// §8a, §8c, §8d, §8e(body length), §8j — the blob-reading pass, one chunk
// ---------------------------------------------------------------------------

// `analyzedRows` — full rows from store.listAnalyzedPosts(), same source
// scanContamination uses. `registryFor(sub)` resolves a subreddit's
// boilerplate-hash Set (async), for classifying comments the same way the
// analyze-time filter does.
async function scanChunk({
  store, context, analyzedRows, limit = 2000, after = null, registryFor,
  minChars = cc.DEFAULT_MIN_CHARS
} = {}) {
  const startedMs = Date.now();
  let read = 0, capped = false, missingBlobs = 0, resumeAfter = null;
  let skipping = !!after;

  const quoteCounts = {}; // { [sub]: { 'post-body':n, 'human-comment':n, 'bot-comment':n, 'not-found':n } }
  // Chunk-LOCAL candidate list, per (subreddit, bucket) — deliberately uncapped
  // here: naturally bounded by this one chunk's row limit (≤4 quotes/row), and
  // never persisted on its own. mergeChunk reservoir-samples these into the
  // persisted accumulator, which is where the real cap (QUOTE_SAMPLE_CAP_PER_PARTITION)
  // applies.
  const quoteSamples = {}; // { [sub]: { 'bot-comment': [...], 'not-found': [...] } }
  const hashHits = []; // [{ hash, sub, rowKey, permalink }] — caller merges into the corpus-wide map
  const emptyRemoved = {};
  const bodyLength = {}; // { [sub]: { count, totalChars } }
  const nonEnglish = {};
  const registryCache = new Map();

  for (const r of analyzedRows) {
    const cursor = `${r.partitionKey}|${r.rowKey}`;
    if (skipping) {
      if (cursor === after) skipping = false;
      continue;
    }
    if (read >= limit) { capped = true; break; }
    resumeAfter = cursor;
    if (kindOf(r) !== 'post' || !r.createdUtc) continue;

    let raw;
    try {
      raw = await store.getRaw(r.partitionKey, r.createdUtc, idFromRowKey(r.rowKey), 'post');
    } catch {
      missingBlobs++;
      continue;
    }
    read++;
    const sub = r.partitionKey;
    const postText = `${(raw.post && raw.post.title) || ''}\n${(raw.post && raw.post.selftext) || ''}`;

    // §8d
    if (isEmptyOrRemoved(raw.post && raw.post.selftext)) {
      emptyRemoved[sub] = (emptyRemoved[sub] || 0) + 1;
    }

    // §8e — body length distribution.
    const bl = bodyLength[sub] || (bodyLength[sub] = { count: 0, totalChars: 0 });
    bl.count++;
    bl.totalChars += ((raw.post && raw.post.selftext) || '').length;

    // §8j
    if (looksNonEnglish(postText)) nonEnglish[sub] = (nonEnglish[sub] || 0) + 1;

    // §8c — duplicate/crosspost hash, this row's contribution only.
    const bodyHash = cc.hashIfEligible(raw.post && raw.post.selftext, minChars);
    if (bodyHash) hashHits.push({ hash: bodyHash, sub, rowKey: r.rowKey, permalink: r.permalink || null });

    // §8a — quote provenance, needs comments split human/bot the same way
    // the analyze-time filter does.
    let registry = registryCache.get(sub);
    if (!registry) {
      registry = registryFor ? await registryFor(sub).catch(() => new Set()) : new Set();
      registryCache.set(sub, registry);
    }
    const humanBodies = [];
    const botBodies = [];
    for (const c of (raw.comments || [])) {
      const { keep } = classifyComment(c, { registry, minChars });
      (keep ? humanBodies : botBodies).push(c.body || '');
    }
    let analysis = null;
    try { analysis = r.analysisJson ? JSON.parse(r.analysisJson) : null; } catch { /* unparseable, skip quote checks for this row */ }
    const qc = quoteCounts[sub] || (quoteCounts[sub] = { 'post-body': 0, 'human-comment': 0, 'bot-comment': 0, 'not-found': 0 });
    for (const { quote } of quoteFieldsOf(analysis)) {
      const bucket = classifyQuote(quote, { postText, humanBodies, botBodies });
      if (!bucket) continue;
      qc[bucket]++;
      if (bucket === 'bot-comment' || bucket === 'not-found') {
        const subBuckets = quoteSamples[sub] || (quoteSamples[sub] = {});
        (subBuckets[bucket] || (subBuckets[bucket] = [])).push({ subreddit: sub, permalink: r.permalink || null, quote });
      }
    }
  }

  context?.log?.(`audit scanChunk: read ${read} blobs, capped=${capped}`);

  return {
    rowsScanned: read, missingBlobs, capped, resumeAfter, limit,
    quoteCounts, quoteSamples, hashHits, emptyRemoved, bodyLength, nonEnglish,
    durationMs: Date.now() - startedMs
  };
}

// ---------------------------------------------------------------------------
// r2 fix — the accumulator's shape contract
// ---------------------------------------------------------------------------
//
// A prior version of this module let `mergeChunk` proceed against WHATEVER
// `acc` it was handed. In production, `saveAggregate`'s shrinkToFit silently
// dropped `hashes` off a 4,000-row accumulator (Table Storage's 32,768-char
// property ceiling; `hashes` alone would have needed hundreds of KB), and the
// NEXT chunk's `mergeChunk(prevAcc, chunk)` — with `prevAcc.hashes` now
// `undefined` — threw on `next.hashes[hit.hash]`, poisoned the queue message
// after 5 retries, and the worker never made progress again.
//
// Two changes close this: (1) the accumulator now lives in Blob Storage
// (lib/store.js's saveBlobJson/getBlobJson), which has no per-property
// ceiling to shrink against — there is no longer a mechanism that can drop a
// field silently. (2) `mergeChunk` validates its `acc` argument and THROWS
// rather than proceeding if required fields are missing or wrong-typed — so
// even a corrupted/foreign value (a stale Table-based row from before this
// fix, a hand-edited blob, anything) fails loud instead of producing a
// TypeError three calls deep. The WORKER (lib/audit-worker.js) is what
// decides to recover from that by resetting to a fresh accumulator and
// restarting the pass — this function's job is only to refuse to proceed on
// bad input, not to repair it.

const REQUIRED_ACC_FIELDS = {
  rowsScanned: 'number', missingBlobs: 'number',
  quoteCounts: 'object', quoteSamples: 'object',
  hashes: 'object', hashCapHit: 'boolean', trackedHashCount: 'number',
  emptyRemoved: 'object', bodyLength: 'object', nonEnglish: 'object'
};

class AccumulatorShapeError extends Error {
  constructor(missing) {
    super(`audit accumulator is missing or has the wrong type for: ${missing.join(', ')}`);
    this.name = 'AccumulatorShapeError';
    this.missing = missing;
  }
}

// Throws AccumulatorShapeError if `acc` is not a valid accumulator. Plain
// objects only (not arrays) for the object-typed fields — an array would
// satisfy `typeof === 'object'` but silently break every `Object.entries`
// merge loop below.
function validateAccumulator(acc) {
  if (!acc || typeof acc !== 'object' || Array.isArray(acc)) throw new AccumulatorShapeError(['(entire accumulator)']);
  const bad = [];
  for (const [key, type] of Object.entries(REQUIRED_ACC_FIELDS)) {
    const v = acc[key];
    if (type === 'object') {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) bad.push(key);
    } else if (typeof v !== type) {
      bad.push(key);
    }
  }
  if (!('cursor' in acc) || (acc.cursor !== null && typeof acc.cursor !== 'string')) bad.push('cursor');
  if (bad.length) throw new AccumulatorShapeError(bad);
  return true;
}

function freshAccumulator() {
  return {
    rowsScanned: 0, missingBlobs: 0,
    quoteCounts: {}, quoteSamples: {},
    hashes: {}, hashCapHit: false, trackedHashCount: 0,
    emptyRemoved: {}, bodyLength: {}, nonEnglish: {},
    cursor: null
  };
}

// Streaming reservoir sampling (Algorithm R): after `bucket.seen` items have
// been offered, `bucket.items` is a uniform random sample of size ≤ cap,
// regardless of how many chunks / calls it took to see them all. `rand` is
// injectable so tests can assert sample selection deterministically.
function reservoirAdd(bucket, item, cap, rand) {
  bucket.seen++;
  if (bucket.items.length < cap) {
    bucket.items.push(item);
  } else {
    const j = Math.floor(rand() * bucket.seen);
    if (j < cap) bucket.items[j] = item;
  }
}

// Merge one chunk's LOCAL findings into a persisted running accumulator.
// `acc` is either `null`/`undefined` (fresh start) or a previously-merged
// accumulator — validated above, not assumed. Duplicate-hash tracking is
// capped at MAX_TRACKED_HASHES distinct hashes corpus-wide, and quote-sample
// tracking at QUOTE_SAMPLE_CAP_PER_PARTITION per (subreddit, bucket) — both
// caps are reported in the accumulator (`hashCapHit`/`trackedHashCount`,
// `quoteSamples[sub][bucket].seen` vs `.items.length`), never silently.
function mergeChunk(acc, chunk, { rand = Math.random } = {}) {
  if (acc != null) validateAccumulator(acc); // requirement: reject bad input, don't patch around it
  const next = acc ? JSON.parse(JSON.stringify(acc)) : freshAccumulator();
  next.rowsScanned += chunk.rowsScanned;
  next.missingBlobs += chunk.missingBlobs;
  if (chunk.resumeAfter != null) next.cursor = chunk.resumeAfter;

  for (const [sub, counts] of Object.entries(chunk.quoteCounts || {})) {
    const dst = next.quoteCounts[sub] || (next.quoteCounts[sub] = { 'post-body': 0, 'human-comment': 0, 'bot-comment': 0, 'not-found': 0 });
    for (const [bucket, n] of Object.entries(counts)) dst[bucket] = (dst[bucket] || 0) + n;
  }
  for (const [sub, buckets] of Object.entries(chunk.quoteSamples || {})) {
    const dstSub = next.quoteSamples[sub] || (next.quoteSamples[sub] = {});
    for (const bucketName of ['bot-comment', 'not-found']) {
      const items = (buckets && buckets[bucketName]) || [];
      if (!items.length) continue;
      const dst = dstSub[bucketName] || (dstSub[bucketName] = { seen: 0, items: [] });
      for (const item of items) reservoirAdd(dst, item, QUOTE_SAMPLE_CAP_PER_PARTITION, rand);
    }
  }
  for (const hit of chunk.hashHits || []) {
    let entry = next.hashes[hit.hash];
    if (!entry) {
      if (next.trackedHashCount >= MAX_TRACKED_HASHES) { next.hashCapHit = true; continue; }
      entry = next.hashes[hit.hash] = { count: 0, subs: [], samples: [] };
      next.trackedHashCount++;
    }
    entry.count++;
    if (!entry.subs.includes(hit.sub)) entry.subs.push(hit.sub);
    if (entry.samples.length < 5) entry.samples.push({ sub: hit.sub, rowKey: hit.rowKey, permalink: hit.permalink });
  }
  for (const [sub, n] of Object.entries(chunk.emptyRemoved || {})) {
    next.emptyRemoved[sub] = (next.emptyRemoved[sub] || 0) + n;
  }
  for (const [sub, bl] of Object.entries(chunk.bodyLength || {})) {
    const dst = next.bodyLength[sub] || (next.bodyLength[sub] = { count: 0, totalChars: 0 });
    dst.count += bl.count;
    dst.totalChars += bl.totalChars;
  }
  for (const [sub, n] of Object.entries(chunk.nonEnglish || {})) {
    next.nonEnglish[sub] = (next.nonEnglish[sub] || 0) + n;
  }
  return next;
}

// Derive the reportable duplicate/crosspost summary from a merged accumulator.
function duplicateSummary(acc) {
  const entries = Object.entries(acc.hashes || {});
  const crossposts = entries.filter(([, e]) => e.subs.length > 1);
  const reposts = entries.filter(([, e]) => e.subs.length === 1 && e.count > 1);
  const top20 = entries
    .filter(([, e]) => e.count > 1)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([hash, e]) => ({ hash, count: e.count, subs: e.subs, samples: e.samples }));
  return {
    crosspostHashes: crossposts.length,
    crosspostRows: crossposts.reduce((s, [, e]) => s + e.count, 0),
    repostHashes: reposts.length,
    repostRows: reposts.reduce((s, [, e]) => s + e.count, 0),
    top20,
    hashCapHit: !!acc.hashCapHit,
    trackedHashCount: acc.trackedHashCount || 0,
    maxTrackedHashes: MAX_TRACKED_HASHES
  };
}

module.exports = {
  EMPTY_MIN_CHARS, QUOTE_MIN_CHARS, DUP_MIN_CHARS, MAX_TRACKED_HASHES,
  QUOTE_SAMPLE_CAP_PER_PARTITION,
  isEmptyOrRemoved, looksNonEnglish, quoteFieldsOf, classifyQuote,
  tableChecks, scanChunk, mergeChunk, duplicateSummary,
  validateAccumulator, freshAccumulator, AccumulatorShapeError
};
