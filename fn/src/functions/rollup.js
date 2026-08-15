'use strict';

// Aggregation rollup: recompute dashboard datasets from the posts table.
// Timer daily 13:00 UTC (after ingest+analysis drain) + manual HTTP trigger.
// Persona synthesis + feature normalization call AOAI (weekly-ish work done daily is
// fine — burn is budgeted).
//
// The aggregation itself lives in lib/rollup-engine.js so it can be unit-tested
// without the Functions host. This file is only the trigger wiring.

const { app } = require('@azure/functions');
const store = require('../lib/store');
const aoai = require('../lib/aoai');
const { runRollup } = require('../lib/rollup-engine');

const run = (context) => runRollup({ store, aoai, context, env: process.env });

app.timer('rollupDaily', {
  schedule: '0 0 13 * * *',
  handler: async (_timer, context) => {
    await run(context);
  }
});

app.http('rollupNow', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (_request, context) => {
    // Must never return an empty body: an empty 200/500 is what made the
    // original failure unreadable from the CLI. Even a total blow-up reports
    // itself as JSON.
    try {
      const summary = await run(context);
      return { status: summary.ok ? 200 : 207, jsonBody: summary };
    } catch (e) {
      context.error(`rollup aborted: ${e.message}`);
      return {
        status: 500,
        jsonBody: {
          ok: false,
          error: e && e.message ? e.message : String(e),
          stack: e && e.stack ? String(e.stack).split('\n').slice(0, 5) : undefined,
          failedAt: new Date().toISOString()
        }
      };
    }
  }
});
