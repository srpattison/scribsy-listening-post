'use strict';

// Retroactive bot/boilerplate classification, and the prompt-contamination scan.
//
//   POST /api/retag                          → tag every row from stored columns (fast, stays synchronous)
//   POST /api/retag?bodies=1                 → QUEUES a body-reading tagging pass (§8m)
//   POST /api/retag?contamination=1          → QUEUES the prompt-contamination scan (§8m)
//   POST /api/retag?dryRun=1                 → report only, write nothing (synchronous, table-only)
//
// NEITHER PATH ENQUEUES ANALYSIS. Exclusion changes the aggregate without
// touching analysisJson. The contamination scan is read-only and exists to turn
// "some unknown fraction of the corpus" into a counted, per-partition row list
// that can be priced — remediation itself is a separate, deliberate decision.
//
// §8m (CB-LISTEN-REPO-7): body reads are capped at 2000 blobs per invocation
// against a corpus of 254,035+ rows — ~110+ sequential HTTP calls, each
// subject to the 4:00 gateway cut, to complete one full-corpus scan. That is
// not operationally viable by hand and only gets worse as the corpus grows.
// So `bodies=1` and `contamination=1` no longer run inline: they enqueue a
// job and return immediately, and a queue-triggered worker (lib/retag-worker.js,
// mirroring backfillWorker's self-requeue-until-exhausted shape) processes the
// corpus in chunks, persisting progress after every chunk via runRetag/
// scanContamination's existing persistReport call — reused unchanged, since
// both were already correctly resumable via bodiesAfter/after cursors. This is
// also what unblocks CB-LISTEN-REPO-7 §8o: the comment-derived boilerplate
// harvest is inside scanContamination, and it can only ever run to completion
// once this scan can actually finish.

const { app } = require('@azure/functions');
const store = require('../lib/store');
const config = require('../lib/config');
const { runRetag } = require('../lib/retag');
const { runRetagChunk, bumpQueueStatus } = require('../lib/retag-worker');

app.storageQueue('retagWorker', {
  queueName: store.RETAG_QUEUE,
  connection: 'AzureWebJobsStorage',
  handler: async (message, context) => {
    const job = typeof message === 'string' ? JSON.parse(message) : message;
    const { kind, capped, resumeAfter, chunkSize } = await runRetagChunk(job, context, { storeImpl: store });
    context.log(`retagWorker(${kind}): capped=${capped}`);
    if (capped) {
      await store.enqueueRetag({ kind, after: resumeAfter, chunkSize }, 5);
    } else {
      context.log(`retagWorker(${kind}): exhausted — full-corpus ${kind} pass complete`);
    }
  }
});

app.http('retag', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    const p = new URL(request.url).searchParams;
    const num = (name, dflt) => {
      const v = parseInt(p.get(name) || '', 10);
      return Number.isFinite(v) && v >= 0 ? v : dflt;
    };

    const wantsBodies = p.get('bodies') === '1';
    const wantsContamination = p.get('contamination') === '1';

    if (wantsBodies || wantsContamination) {
      // §8m: a body/contamination scan reliably exceeds the 4:00 gateway cut
      // at this corpus size and always will — queue it, don't run it inline.
      await store.ensureInfra();
      const queued = [];
      if (wantsBodies) {
        await store.enqueueRetag({ kind: 'bodies', chunkSize: num('bodyLimit', 2000) });
        await bumpQueueStatus(store, 'bodies', { queuedAt: new Date().toISOString(), exhausted: false });
        queued.push('bodies');
      }
      if (wantsContamination) {
        await store.enqueueRetag({ kind: 'contamination', chunkSize: num('limit', 2000) });
        await bumpQueueStatus(store, 'contamination', { queuedAt: new Date().toISOString(), exhausted: false });
        queued.push('contamination');
      }
      context.log(`retag: queued ${queued.join(', ')} — poll GET /api/insights?view=health (retagQueueStatus) for progress`);
      return {
        status: 202,
        jsonBody: {
          queued: true,
          jobs: queued,
          note: 'Body/contamination reads run as a self-requeuing queue worker (§8m). Poll GET /api/insights?view=health and read retagQueueStatus for monotonic progress; the final report lands at retag / retagContamination once exhausted:true.'
        }
      };
    }

    // Table-only tagging pass: no blob reads, completes well inside the
    // gateway window (measured 16.6s over 219,190 rows) — stays synchronous.
    try {
      const result = await runRetag({
        store,
        context,
        minRepeats: config.boilerplateMinRepeats(),
        minChars: config.boilerplateMinCharsBody(),
        minTitleChars: config.boilerplateMinCharsTitle(),
        bodies: false,
        dryRun: p.get('dryRun') === '1'
      });
      context.log(
        `retag: scanned ${result.scanned}, changed ${result.changed}, ` +
        `bot ${result.tagged.bot}, boilerplate ${result.tagged.boilerplate}`
      );
      return { jsonBody: result };
    } catch (e) {
      context.error(`retag failed: ${e.message}`);
      return { status: 500, jsonBody: { ok: false, error: e.message, failedAt: new Date().toISOString() } };
    }
  }
});
