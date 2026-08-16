'use strict';

// Retroactive content classification (CB-LISTEN-REPO-5 §3d).
//
// The existing corpus is already contaminated, and every rollup until this ships
// produces biased answers. This re-tags it in place.
//
// HARD CONSTRAINT: zero model calls. Exclusion changes the aggregate without
// touching any row's analysisJson — the analysed content of a bot row is fine to
// leave in place, it simply stops being counted. Nothing here enqueues analysis,
// and fn/test/retag.test.js asserts that against a queue spy.
//
// Row bodies are not stored in the posts table, only in the `raw` blob archive.
// Reading them is opt-in (`bodies: true`) because blob reads are Flex
// wall-clock, which round 4 established is the dominant cost of this system.
// The default pass uses stored columns and title repeat-hash, which already
// catches scheduled megathreads (they repeat both title and author).

const cc = require('./content-class');
const { kindOf, idFromRowKey } = require('./rowkeys');

async function runRetag({
  store,
  context,
  minRepeats = cc.DEFAULT_MIN_REPEATS,
  minChars = cc.DEFAULT_MIN_CHARS,
  bodies = false,
  bodyLimit = 2000,
  dryRun = false
} = {}) {
  const startedMs = Date.now();
  const rows = await store.listRowsForRetag();

  // Optional pass: pull bodies from the raw archive so the general repeat-hash
  // detector can see post text, not just titles.
  let bodiesRead = 0;
  let bodiesCapped = false;
  const bodyByKey = new Map();
  if (bodies) {
    for (const r of rows) {
      if (bodiesRead >= bodyLimit) { bodiesCapped = true; break; }
      if (!r.createdUtc) continue;
      try {
        const raw = await store.getRaw(r.partitionKey, r.createdUtc, idFromRowKey(r.rowKey), kindOf(r));
        const text = (raw && raw.post && raw.post.selftext) || '';
        if (text) bodyByKey.set(`${r.partitionKey}|${r.rowKey}`, text);
        bodiesRead++;
      } catch {
        // A missing blob is not an error here — fall back to title + signals.
      }
    }
  }

  const shaped = rows.map((r) => ({
    partitionKey: r.partitionKey,
    rowKey: r.rowKey,
    subreddit: r.partitionKey,
    author: r.author,
    title: r.title,
    body: bodyByKey.get(`${r.partitionKey}|${r.rowKey}`) || '',
    distinguished: r.distinguished,
    stickied: r.stickied === true,
    previousClass: r.contentClass || null
  }));

  const index = cc.buildRepeatIndex(shaped, { minChars });

  const tagged = { bot: 0, boilerplate: 0, human: 0 };
  const byReason = {};
  const byPartition = {};
  let changed = 0;

  for (const row of shaped) {
    const { contentClass, contentClassReason } = cc.classifyRow(row, index, { minRepeats, minChars });
    tagged[contentClass] = (tagged[contentClass] || 0) + 1;
    if (contentClassReason) byReason[contentClassReason] = (byReason[contentClassReason] || 0) + 1;
    if (contentClass !== cc.CLASS_HUMAN) {
      byPartition[row.partitionKey] = byPartition[row.partitionKey] || { bot: 0, boilerplate: 0 };
      byPartition[row.partitionKey][contentClass]++;
    }
    if (row.previousClass === contentClass) continue; // already correct — no write
    changed++;
    if (dryRun) continue;
    try {
      await store.setContentClass(row.partitionKey, row.rowKey, contentClass, contentClassReason);
    } catch (e) {
      context?.warn?.(`retag write failed for ${row.partitionKey}/${row.rowKey}: ${e.message}`);
    }
  }

  return {
    scanned: rows.length,
    changed,
    dryRun,
    tagged: { bot: tagged.bot || 0, boilerplate: tagged.boilerplate || 0, human: tagged.human || 0 },
    byReason,
    byPartition,
    thresholds: { minRepeats, minChars },
    bodies: { requested: bodies, read: bodiesRead, capped: bodiesCapped, limit: bodyLimit },
    analysisJobsEnqueued: 0, // structural: this module never enqueues
    durationMs: Date.now() - startedMs
  };
}

// ---------------------------------------------------------------------------
// Prompt-contamination scan (§4 follow-up) — READ ONLY, zero model calls.
// ---------------------------------------------------------------------------
//
// Row-level tagging cannot reach this. Pre-round-4, comments were never merged
// into the parent's stored record — they were passed to the model as prompt
// context. What persists in a genuinely human row's analysisJson is therefore:
//
//   narrow — a verbatim quote field lifted from a bot/boilerplate comment.
//            Visible on the dashboard, which is how this was caught.
//   broad  — any bot/boilerplate comment present in the prompt at all.
//            Invisible, and the one that matters: comment_stance_mix counted
//            those replies as community stances, and that feeds the stance
//            frame behind the loud-minority question. Once a bot comment was
//            in the prompt the mix is unreliable whether or not its text
//            surfaced in a quote, so narrow undercounts.
//
// Both counts are reported per partition. Neither triggers remediation — which
// rows are worth reanalyzing is a budget decision, not an implementation one.

const QUOTE_MIN_CHARS = 25; // below this a "match" is coincidence, not provenance

function quotesFrom(analysis) {
  if (!analysis || typeof analysis !== 'object') return [];
  const out = [];
  if (analysis.notable_quote) out.push(analysis.notable_quote);
  for (const field of ['deal_breakers', 'trust_signals', 'feature_requests']) {
    for (const item of analysis[field] || []) {
      if (item && item.quote) out.push(item.quote);
    }
  }
  return out.filter((q) => cc.normalizeText(q).length >= QUOTE_MIN_CHARS);
}

async function scanContamination({
  store,
  context,
  limit = 5000,
  minRepeats = cc.DEFAULT_MIN_REPEATS,
  minChars = cc.DEFAULT_MIN_CHARS
} = {}) {
  const startedMs = Date.now();
  const rows = await store.listAnalyzedPosts();

  // Pass 1: pull each row's archived comments, and index them for repeat-hash.
  const perRow = [];
  let read = 0, capped = false, missingBlobs = 0;
  for (const r of rows) {
    if (read >= limit) { capped = true; break; }
    if (kindOf(r) !== 'post' || !r.createdUtc) continue;
    let raw;
    try {
      raw = await store.getRaw(r.partitionKey, r.createdUtc, idFromRowKey(r.rowKey), 'post');
    } catch {
      missingBlobs++;
      continue;
    }
    read++;
    const comments = (raw && raw.comments) || [];
    if (!comments.length) continue; // no comments were ever in this prompt
    let analysis = null;
    try { analysis = r.analysisJson ? JSON.parse(r.analysisJson) : null; } catch { /* unparseable — counted elsewhere */ }
    perRow.push({
      partitionKey: r.partitionKey,
      rowKey: r.rowKey,
      comments: comments.map((c) => ({
        subreddit: r.partitionKey,
        author: c.author,
        title: '',
        body: c.body || ''
      })),
      quotes: quotesFrom(analysis)
    });
  }

  // Repeat-hash over the comment corpus: sticky rule text recurs across threads
  // within a sub, which is exactly what the index is built to see.
  const allComments = perRow.flatMap((p) => p.comments);
  const index = cc.buildRepeatIndex(allComments, { minChars });

  const totals = { eligible: 0, narrow: 0, broad: 0 };
  const byPartition = {};
  for (const row of perRow) {
    totals.eligible++;
    const bucket = byPartition[row.partitionKey] || (byPartition[row.partitionKey] = { eligible: 0, narrow: 0, broad: 0 });
    bucket.eligible++;

    const flagged = row.comments.filter((c) => !cc.isHuman(cc.classifyRow(c, index, { minRepeats, minChars })));
    if (!flagged.length) continue;

    totals.broad++; bucket.broad++;

    const flaggedText = flagged.map((c) => cc.normalizeText(c.body));
    const lifted = row.quotes.some((q) => {
      const nq = cc.normalizeText(q);
      return flaggedText.some((t) => t.includes(nq));
    });
    if (lifted) { totals.narrow++; bucket.narrow++; }
  }

  context?.log?.(`contamination scan: ${totals.broad} broad / ${totals.narrow} narrow of ${totals.eligible} eligible rows`);

  return {
    rowsScanned: read,
    rowsWithComments: totals.eligible,
    missingBlobs,
    capped,
    limit,
    narrow: totals.narrow,
    broad: totals.broad,
    narrowShare: totals.eligible ? totals.narrow / totals.eligible : 0,
    broadShare: totals.eligible ? totals.broad / totals.eligible : 0,
    byPartition,
    thresholds: { minRepeats, minChars, quoteMinChars: QUOTE_MIN_CHARS },
    analysisJobsEnqueued: 0,
    durationMs: Date.now() - startedMs,
    note: 'narrow = a verbatim quote field was lifted from a bot/boilerplate comment. broad = any bot/boilerplate comment was in the prompt, so comment_stance_mix is unreliable regardless. Remediation requires reanalyze and is a budget decision; nothing was enqueued.'
  };
}

module.exports = { runRetag, scanContamination, quotesFrom, QUOTE_MIN_CHARS };
