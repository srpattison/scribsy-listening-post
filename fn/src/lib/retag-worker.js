'use strict';

// Queue-message processing for the `retagWorker` trigger (§8m, CB-LISTEN-
// REPO-7) — extracted for the same reason analyze-worker.js and audit-
// worker.js were: lib/*.js holds testable logic, functions/*.js only wires
// a trigger, and that's what makes the self-requeue/exhaustion contract
// testable without mocking the Azure Functions host.
//
// Reuses runRetag/scanContamination UNCHANGED — both were already correctly
// resumable via bodiesAfter/after cursors and already persist their own
// report via persistReport() after every chunk. This module's only job is
// the queue-worker shape around them: track cumulative progress across
// chunks (the underlying reports only reflect the LAST chunk's window) and
// self-requeue until exhausted, the same shape as backfillWorker.

const config = require('./config');
const { runRetag, scanContamination } = require('./retag');

const QUEUE_STATUS_PARTITION = 'retag-queue-status';

// Blind (non-CAS) read-modify-write is safe here: the retag queue only ever
// has ONE message in flight at a time (each chunk finishes and enqueues the
// next before the worker returns) — no concurrent-writer race like analyze's
// 16-way batch, so §8n's CAS fix does not apply (N=1 here, not N>1).
async function bumpQueueStatus(storeImpl, kind, patch) {
  const prev = (await storeImpl.getAggregate(QUEUE_STATUS_PARTITION, kind)) || { readTotal: 0, chunks: 0 };
  await storeImpl.saveAggregate(QUEUE_STATUS_PARTITION, kind, {
    ...prev,
    ...patch,
    readTotal: (prev.readTotal || 0) + (patch.readDelta || 0),
    chunks: (prev.chunks || 0) + 1,
    updatedAt: new Date().toISOString()
  });
}

async function runRetagChunk(job, context, { storeImpl } = {}) {
  await storeImpl.ensureInfra();
  const kind = job.kind === 'contamination' ? 'contamination' : 'bodies';
  const chunkSize = job.chunkSize || 2000;

  if (kind === 'bodies') {
    const result = await runRetag({
      store: storeImpl,
      context,
      minRepeats: config.boilerplateMinRepeats(),
      minChars: config.boilerplateMinCharsBody(),
      minTitleChars: config.boilerplateMinCharsTitle(),
      bodies: true,
      bodyLimit: chunkSize,
      bodiesAfter: job.after || null
    });
    await bumpQueueStatus(storeImpl, 'bodies', {
      readDelta: result.bodies.read,
      capped: result.bodies.capped,
      resumeAfter: result.bodies.resumeAfter,
      exhausted: !result.bodies.capped,
      lastScanned: result.scanned,
      lastTagged: result.tagged
    });
    return { kind, capped: result.bodies.capped, resumeAfter: result.bodies.resumeAfter, chunkSize, result };
  }

  const result = await scanContamination({
    store: storeImpl,
    context,
    limit: chunkSize,
    after: job.after || null,
    minRepeats: config.boilerplateMinRepeats(),
    minChars: config.boilerplateMinCharsBody()
  });
  await bumpQueueStatus(storeImpl, 'contamination', {
    readDelta: result.rowsScanned,
    capped: result.capped,
    resumeAfter: result.resumeAfter,
    exhausted: !result.capped,
    lastBroad: result.broad,
    lastNarrow: result.narrow
  });
  return { kind, capped: result.capped, resumeAfter: result.resumeAfter, chunkSize, result };
}

module.exports = { runRetagChunk, bumpQueueStatus, QUEUE_STATUS_PARTITION };
