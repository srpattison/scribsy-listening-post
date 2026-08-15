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
const { kindOf, idFromRowKey } = require('../lib/rowkeys');
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

    // `kind=comments|posts` scopes the re-run. Comments still pass through
    // COMMENT_ANALYZE_POLICY in the analyzer, so a reanalyze can never be the
    // thing that silently switches comment spend on.
    const kindFilter = p.get('kind');

    const rows = await store.listAnalyzedPosts();
    let enqueued = 0, skipped = 0, comments = 0;
    for (const r of rows) {
      if (enqueued >= limit) break;
      if (sub && r.partitionKey !== sub) continue;
      const kind = kindOf(r);
      if (kindFilter === 'comments' && kind !== 'comment') continue;
      if (kindFilter === 'posts' && kind !== 'post') continue;
      const v = r.schemaVersion || 1;
      if (!force && v >= minVersion) { skipped++; continue; }
      if (!r.createdUtc) { skipped++; continue; }
      // The bare id plus kind — the analyzer re-derives the row key and blob
      // name. Passing the prefixed key would relabel comments as submissions.
      await store.enqueueAnalysis({
        subreddit: r.partitionKey, id: idFromRowKey(r.rowKey), created_utc: r.createdUtc, kind
      });
      if (kind === 'comment') comments++;
      enqueued++;
    }
    context.log(`reanalyze: enqueued ${enqueued} (${comments} comments), current ${skipped}, target v${force ? 'ALL' : minVersion}`);
    return {
      jsonBody: {
        enqueued, comments, alreadyCurrent: skipped, currentSchemaVersion: SCHEMA_VERSION,
        note: 'Comments remain subject to COMMENT_ANALYZE_POLICY; under ingest-only they are re-enqueued and dropped without a model call.'
      }
    };
  }
});
