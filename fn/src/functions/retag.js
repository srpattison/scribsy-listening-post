'use strict';

// Retroactive bot/boilerplate classification, and the prompt-contamination scan.
//
//   POST /api/retag                          → tag every row from stored columns
//   POST /api/retag?bodies=1&bodyLimit=2000  → also hash post bodies from `raw`
//   POST /api/retag?dryRun=1                 → report only, write nothing
//   POST /api/retag?contamination=1&limit=N  → additionally report narrow/broad
//                                              prompt contamination per partition
//
// NEITHER PATH ENQUEUES ANALYSIS. Exclusion changes the aggregate without
// touching analysisJson. The contamination scan is read-only and exists to turn
// "some unknown fraction of the corpus" into a counted, per-partition row list
// that can be priced — remediation itself is a separate, deliberate decision.

const { app } = require('@azure/functions');
const store = require('../lib/store');
const config = require('../lib/config');
const { runRetag, scanContamination } = require('../lib/retag');

app.http('retag', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    const p = new URL(request.url).searchParams;
    const num = (name, dflt) => {
      const v = parseInt(p.get(name) || '', 10);
      return Number.isFinite(v) && v >= 0 ? v : dflt;
    };
    try {
      const result = await runRetag({
        store,
        context,
        minRepeats: config.boilerplateMinRepeats(),
        minChars: config.boilerplateMinCharsBody(),
        minTitleChars: config.boilerplateMinCharsTitle(),
        bodies: p.get('bodies') === '1',
        bodyLimit: num('bodyLimit', 2000),
        bodiesAfter: p.get('bodiesAfter') || null,
        dryRun: p.get('dryRun') === '1'
      });

      if (p.get('contamination') === '1') {
        // Persisted independently before this returns — a gateway cut must not
        // be able to destroy the counts again (§3d).
        result.promptContamination = await scanContamination({
          store,
          context,
          limit: num('limit', 5000),
          after: p.get('after') || null,
          minRepeats: config.boilerplateMinRepeats(),
          minChars: config.boilerplateMinCharsBody()
        });
      }

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
