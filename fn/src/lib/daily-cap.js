'use strict';

// Concurrency-safe counters for the three read-modify-write guardrails that
// shared one defect (CB-LISTEN-REPO-7 §8n): DAILY_ANALYZE_CAP, the prompt
// filter tally, and the comment gate tally. All three were a blind
// getAggregate → mutate → saveAggregate with no concurrency control, so N
// concurrent queue handlers collapsed into roughly one effective increment
// per batch (analyze.js:159 measured a 2.8x overrun at batchSize=16 — the
// effective ceiling was DAILY_ANALYZE_CAP × concurrency, not DAILY_ANALYZE_CAP).
//
// `backend` is the {get, put} shape from store.aggregateBackend(metric, period).

const { casUpdate } = require('./cas');

// Reserve-before-spend admission control. Every caller — win or lose —
// atomically claims the NEXT ticket number via CAS; whether that ticket is
// within cap is decided AFTER the reservation, not before (§8n requirement 1).
// This is what makes it correct under concurrency: there is no read-then-check
// window in which two handlers can both observe "under cap" and both proceed.
async function reserveDailySlot(backend, cap, opts = {}) {
  const next = await casUpdate(
    backend,
    (prev) => ({ count: ((prev && prev.count) || 0) + 1 }),
    { ...opts, label: opts.label || 'analyze-counter' }
  );
  return { ok: next.count <= cap, count: next.count };
}

// Daily tally of what the prompt-side filter removed (§3c), now CAS-safe.
async function recordFiltered(backend, reasons, opts = {}) {
  const names = Object.keys(reasons || {});
  if (!names.length) return null;
  return casUpdate(
    backend,
    (prev) => {
      const byReason = { ...((prev && prev.byReason) || {}) };
      let added = 0;
      for (const [reason, n] of Object.entries(reasons)) {
        byReason[reason] = (byReason[reason] || 0) + n;
        added += n;
      }
      return { total: ((prev && prev.total) || 0) + added, byReason };
    },
    { ...opts, label: opts.label || 'filter-counter' }
  );
}

// Running comment-gate tallies (§3b), now CAS-safe.
async function bumpCommentCounter(backend, field, opts = {}) {
  return casUpdate(
    backend,
    (prev) => {
      const next = {
        seen: (prev && prev.seen) || 0,
        analyzed: (prev && prev.analyzed) || 0,
        skipped: (prev && prev.skipped) || 0
      };
      next[field] = (next[field] || 0) + 1;
      return next;
    },
    { ...opts, label: opts.label || 'comment-gate' }
  );
}

module.exports = { reserveDailySlot, recordFiltered, bumpCommentCounter };
