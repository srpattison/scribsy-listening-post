'use strict';

// Queue-message processing for the `auditWorker` trigger — extracted from
// functions/audit.js for the same reason analyze-worker.js was: this
// codebase's convention is that lib/*.js holds testable logic and
// functions/*.js only wires a trigger to it, and that convention is what
// makes a reserve-before-spend / resumable-worker test possible without
// mocking the Azure Functions host.
//
// r2 fix (live incident, 2026-08-16 20:49Z–23:03Z): the accumulator now lives
// in Blob Storage (store.saveBlobJson/getBlobJson), not the `aggregates`
// table — Table Storage's 32,768-char property ceiling let shrinkToFit
// silently drop `hashes` off a 4,000-row accumulator, and the next chunk's
// mergeChunk() threw on the missing field, poisoning the queue message after
// 5 retries. See lib/audit.js's header comment on mergeChunk for the full
// mechanism. The accumulator is also now the SOLE source of truth for where
// to resume: `job.chunkSize` still comes from the queue message, but the scan
// cursor comes from `acc.cursor`, not `job.after` — so a corrupt/incompatible
// accumulator and a stale cursor can never disagree with each other. If the
// loaded accumulator is missing (never written), unreadable, or fails
// validation, the worker logs why and starts a clean full pass rather than
// crash-looping forever.

const config = require('./config');
const audit = require('./audit');
const registry = require('./boilerplate-registry');
const { persistReport } = require('./retag');

const ACCUMULATOR_NAME = 'audit-accumulator';

function safeSubTags() {
  try { return config.subTags(); } catch { return {}; } // §8f degrades to "no enclave split" rather than failing the audit
}

// Load the accumulator, resolving to `null` (start clean) with a logged
// reason whenever the stored value cannot be trusted: absent, unreadable
// (`__corrupt`, from getBlobJson's own read-side contract), or structurally
// invalid (audit.validateAccumulator). Never throws — an unloadable
// accumulator is a reason to restart the pass, not to poison the message.
async function loadAccumulator(storeImpl, context) {
  const raw = await storeImpl.getBlobJson(ACCUMULATOR_NAME);
  if (raw == null) return null; // never written yet — a genuinely fresh start, not a recovery
  if (raw.__corrupt) {
    context.warn(`audit accumulator blob is unreadable (${raw.error}) — restarting the full audit pass from scratch`);
    return null;
  }
  try {
    audit.validateAccumulator(raw);
  } catch (e) {
    context.warn(`audit accumulator failed validation (${e.message}) — restarting the full audit pass from scratch`);
    return null;
  }
  return raw;
}

// One chunk: the table-only checks (§8b/§8f/§8g/§8h/§8i, §8e's flair part)
// plus one bounded window of the blob-reading pass (§8a/§8c/§8d/§8e's
// body-length part/§8j), merged into a persisted running accumulator so
// `view=health` reflects the WHOLE corpus scanned so far, not just the last
// chunk's window. `deps` lets tests inject a fake store/registry.
async function runAuditChunk(job, context, { storeImpl, registryImpl = registry } = {}) {
  await storeImpl.ensureInfra();
  const chunkSize = job.chunkSize || 2000;

  const [tableRows, analyzedRows] = await Promise.all([
    storeImpl.listRowsForAudit(),
    storeImpl.listAnalyzedPosts()
  ]);
  const table = audit.tableChecks(tableRows, { subTags: safeSubTags() });

  const prevAcc = await loadAccumulator(storeImpl, context);
  const restarted = prevAcc == null && job.after != null; // a resume was requested but the accumulator couldn't back it up
  const after = prevAcc ? prevAcc.cursor : null; // the accumulator is the sole source of truth for where to resume

  const chunk = await audit.scanChunk({
    store: storeImpl,
    context,
    analyzedRows,
    limit: chunkSize,
    after,
    registryFor: (sub) => registryImpl.load(storeImpl, sub),
    minChars: audit.DUP_MIN_CHARS
  });
  const acc = audit.mergeChunk(prevAcc, chunk);
  // No shrinkToFit here — a blob write either fully succeeds or throws.
  await storeImpl.saveBlobJson(ACCUMULATOR_NAME, acc);

  const dup = audit.duplicateSummary(acc);
  const report = {
    exhausted: !chunk.capped,
    resumeAfter: chunk.capped ? chunk.resumeAfter : null,
    restarted, // true when this chunk had to discard an unusable accumulator (§ r2 requirement 5)
    rowsScannedSoFar: acc.rowsScanned,
    missingBlobs: acc.missingBlobs,
    quoteProvenance: {
      byPartition: acc.quoteCounts, // full counts — unaffected by sampling
      samples: acc.quoteSamples,    // { [sub]: { bucket: { seen, items } } } — `seen` vs items.length makes the sample cap visible, not silent
      sampleCapPerPartition: audit.QUOTE_SAMPLE_CAP_PER_PARTITION,
      minChars: audit.QUOTE_MIN_CHARS
    }, // §8a
    duplicates: dup, // §8c — includes hashCapHit/trackedHashCount/maxTrackedHashes, the same "cap is visible, not silent" treatment
    emptyOrRemoved: { byPartition: acc.emptyRemoved, minChars: audit.EMPTY_MIN_CHARS }, // §8d
    bodyLength: acc.bodyLength, // §8e — body-length part
    nonEnglish: { byPartition: acc.nonEnglish }, // §8j
    authorConcentration: table.authorConcentration, // §8b
    subConcentration: table.subConcentration, // §8f
    temporal: table.temporal, // §8g
    stanceCoherence: table.stanceCoherence, // §8h
    botDetectionCoverage: table.botDetectionCoverage, // §8i
    fiction: {
      flairBySub: table.flairBySub,
      sample: table.fictionSample,
      note: 'signals only — flair distribution and a sample of critique-oriented rows with their extracted stance_on_ai. Indicative, not conclusive; interpretation is Steven\'s (§8e).'
    },
    durationMs: chunk.durationMs,
    finishedAt: new Date().toISOString()
  };
  // Persisted BEFORE any caller sees it — same "an operation that can be cut
  // must not depend on its response reaching anyone" rule §3d/§8 establish,
  // now applied to a worker with no HTTP caller waiting on it at all.
  await persistReport(storeImpl, 'audit', report, { context });
  return { report, capped: chunk.capped, resumeAfter: chunk.resumeAfter, chunkSize, rowsThisChunk: chunk.rowsScanned, restarted };
}

module.exports = { runAuditChunk, loadAccumulator, ACCUMULATOR_NAME };
