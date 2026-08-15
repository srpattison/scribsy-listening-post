'use strict';

// Selective re-analysis from the raw archive — the schema-evolution mechanism.
//   POST /api/reanalyze?limit=500          → re-enqueue rows below current SCHEMA_VERSION
//   POST /api/reanalyze?minVersion=4       → explicit target version
//   POST /api/reanalyze?force=1&sub=writing → everything (optionally one sub)
// Jobs flow through the normal analyze queue, so the daily cap and cost
// guardrails apply unchanged. Raw blobs are the source of truth; nothing is
// re-fetched from Reddit.

const { app } = require('@azure/functions');
const store = require('../lib/store');
const { SCHEMA_VERSION } = require('../lib/taxonomy');

app.http('reanalyze', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    const p = new URL(request.url).searchParams;
    const minVersion = parseInt(p.get('minVersion') || String(SCHEMA_VERSION), 10);
    const limit = Math.min(parseInt(p.get('limit') || '2000', 10), 10000);
    const force = p.get('force') === '1';
    const sub = (p.get('sub') || '').toLowerCase();

    const rows = await store.listAnalyzedPosts();
    let enqueued = 0, skipped = 0;
    for (const r of rows) {
      if (enqueued >= limit) break;
      if (sub && r.partitionKey !== sub) continue;
      const v = r.schemaVersion || 1;
      if (!force && v >= minVersion) { skipped++; continue; }
      if (!r.createdUtc) { skipped++; continue; }
      await store.enqueueAnalysis({ subreddit: r.partitionKey, id: r.rowKey, created_utc: r.createdUtc });
      enqueued++;
    }
    context.log(`reanalyze: enqueued ${enqueued}, current ${skipped}, target v${force ? 'ALL' : minVersion}`);
    return { jsonBody: { enqueued, alreadyCurrent: skipped, currentSchemaVersion: SCHEMA_VERSION } };
  }
});
