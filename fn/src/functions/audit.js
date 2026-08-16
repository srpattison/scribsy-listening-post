'use strict';

// Corpus quality audit — CB-LISTEN-REPO-6 §8, adopted by CB-LISTEN-REPO-7 §1
// ("the full spec for this round is CB-LISTEN-REPO-6 §8, §9 and §10").
//
// Read-only, zero model calls. §8m makes this a hard requirement: `/api/audit`
// MUST be queue-driven, not HTTP-driven. `POST /api/audit` enqueues a job and
// returns a job id immediately; a queue-triggered worker — the same shape as
// backfillWorker, the reference implementation §8m names explicitly —
// processes the corpus across as many chunked invocations as needed, writing
// progress and partial results to `aggregates` after every chunk, until
// exhausted. Nobody ever waits on an HTTP call that cannot succeed: at 2000
// blobs/invocation against 254,035+ rows this is ~110+ sequential calls, each
// subject to the 4:00 gateway cut.
//
// The actual per-chunk logic lives in lib/audit-worker.js (testable the way
// every other pass in this codebase is); this file only wires the trigger.

const crypto = require('node:crypto');
const { app } = require('@azure/functions');
const store = require('../lib/store');
const { runAuditChunk } = require('../lib/audit-worker');

app.storageQueue('auditWorker', {
  queueName: store.AUDIT_QUEUE,
  connection: 'AzureWebJobsStorage',
  handler: async (message, context) => {
    const job = typeof message === 'string' ? JSON.parse(message) : message;
    const { capped, resumeAfter, chunkSize, rowsThisChunk } = await runAuditChunk(job, context, { storeImpl: store });
    context.log(`auditWorker: chunk done — ${rowsThisChunk} rows this chunk, capped=${capped}`);
    if (capped) {
      await store.enqueueAudit({ after: resumeAfter, chunkSize }, 5);
    } else {
      context.log('auditWorker: exhausted — full-corpus audit complete');
    }
  }
});

app.http('audit', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    const p = new URL(request.url).searchParams;
    const chunkSize = Math.min(Math.max(parseInt(p.get('chunkSize') || '2000', 10) || 2000, 1), 5000);
    await store.ensureInfra();
    const jobId = crypto.randomUUID();
    await store.enqueueAudit({ jobId, chunkSize });
    context.log(`audit: queued job ${jobId} (chunkSize=${chunkSize})`);
    return {
      status: 202,
      jsonBody: {
        queued: true,
        jobId,
        note: 'Zero-model-call corpus audit runs as a self-requeuing queue worker (§8m), same shape as backfillWorker. Poll GET /api/insights?view=health and read `audit` for monotonic progress; `audit.exhausted:true` marks a completed full-corpus pass.'
      }
    };
  }
});
