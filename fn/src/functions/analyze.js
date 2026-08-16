'use strict';

// Queue-triggered analysis: one corpus item per message → AOAI classification →
// posts table. Handles both submissions and comments.
//
// The actual per-message logic lives in lib/analyze-worker.js (concurrency-
// safe counters, reserve-before-spend cap admission — CB-LISTEN-REPO-7 §8n).
// This file only wires the trigger.

const { app } = require('@azure/functions');
const store = require('../lib/store');
const { processAnalyzeJob } = require('../lib/analyze-worker');

app.storageQueue('analyze', {
  queueName: store.ANALYZE_QUEUE,
  connection: 'AzureWebJobsStorage',
  handler: async (message, context) => {
    const job = typeof message === 'string' ? JSON.parse(message) : message;
    await processAnalyzeJob(job, context);
  }
});
