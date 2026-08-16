'use strict';

// Queue-message processing for the `auditWorker` trigger — extracted from
// functions/audit.js for the same reason analyze-worker.js was: this
// codebase's convention is that lib/*.js holds testable logic and
// functions/*.js only wires a trigger to it, and that convention is what
// makes a reserve-before-spend / resumable-worker test possible without
// mocking the Azure Functions host.

const config = require('./config');
const audit = require('./audit');
const registry = require('./boilerplate-registry');
const { persistReport } = require('./retag');

function safeSubTags() {
  try { return config.subTags(); } catch { return {}; } // §8f degrades to "no enclave split" rather than failing the audit
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

  const prevAcc = await storeImpl.getAggregate('audit-accumulator', 'latest');
  const chunk = await audit.scanChunk({
    store: storeImpl,
    context,
    analyzedRows,
    limit: chunkSize,
    after: job.after || null,
    registryFor: (sub) => registryImpl.load(storeImpl, sub),
    minChars: audit.DUP_MIN_CHARS
  });
  const acc = audit.mergeChunk(prevAcc && !prevAcc.error ? prevAcc : null, chunk);
  await storeImpl.saveAggregate('audit-accumulator', 'latest', acc);

  const dup = audit.duplicateSummary(acc);
  const report = {
    exhausted: !chunk.capped,
    resumeAfter: chunk.capped ? chunk.resumeAfter : null,
    rowsScannedSoFar: acc.rowsScanned,
    missingBlobs: acc.missingBlobs,
    quoteProvenance: { byPartition: acc.quoteCounts, samples: acc.quoteSamples, minChars: audit.QUOTE_MIN_CHARS }, // §8a
    duplicates: dup, // §8c
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
  return { report, capped: chunk.capped, resumeAfter: chunk.resumeAfter, chunkSize, rowsThisChunk: chunk.rowsScanned };
}

module.exports = { runAuditChunk };
