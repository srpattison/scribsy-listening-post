'use strict';

// Self-healing backfill sweep (CB-LISTEN-CORRECT-1 §4).
//
// THE FAILURE CLASS THIS RETIRES: a backfill job re-enqueues ITSELF until the
// walk is exhausted (functions/backfill.js) — the watermark is the state, the
// queue message is just a wake-up call. If the host restarts or scales in
// after a message is dequeued but before its successor is enqueued, the chain
// breaks permanently and silently: the status row still says `queued: true`,
// no message exists in `backfill-jobs` or its poison queue, nothing errors,
// nothing alerts. The automatic seeder in daily ingest only enqueues for subs
// with NO backfill history, so a sub WITH history can never self-heal. Live
// evidence 2026-08-23: ao3 (watermark a full year short), betteroffline,
// worldbuilding, writingcirclejerk (never started) — all `queued: true`,
// frozen seven days, both queues empty.
//
// THE SWEEP: on the daily ingest schedule, any sub whose backfill-status says
// `queued: true, exhausted: false` with no observed activity for longer than
// the staleness threshold gets a fresh wake-up message. The worker resumes
// from the watermark — this never restarts a walk (a sub with no watermark,
// like writingcirclejerk, starts from the top of its window, which IS the
// correct fresh seed for a walk that never began).
//
// IDEMPOTENCY: a live chain refreshes the status row's `updatedAt` on every
// chunk (minutes apart), so a chain that is actually running can never look
// stale against an hours-scale threshold — the sweep cannot double-enqueue
// over a working chain. The sweep's own re-enqueue records `sweepRequeuedAt`
// on the status row, and staleness is judged against the LATEST of
// updatedAt / sweepRequeuedAt, so a second sweep inside the threshold window
// (e.g. a manual ingestNow right after the timer) skips the sub rather than
// enqueueing a duplicate.
//
// NEGATIVE CONTROL (acceptance §7.6): `exhausted: true` is a finished walk and
// is NEVER re-enqueued, however stale its row.

// Staleness threshold before a queued, unexhausted, silent walk counts as
// orphaned. Generous by design: a healthy chain writes status every chunk
// (~minutes), the sweep runs daily, so 24h is far outside any live cadence
// while still healing an orphan on the next daily ingest.
const BACKFILL_SWEEP_STALE_HOURS_DEFAULT = 24;

// Status/watermark key builders — single source of truth, shared with
// functions/backfill.js. Watermark namespaces are SEPARATE per walk kind: the
// post walks are complete 12-month walks and must never be restarted by a
// comment walk (§3a.4).
const watermarkKey = (sub, kind) =>
  (kind === 'comments' ? `backfill:reddit-comments:${sub.toLowerCase()}` : `backfill:reddit:${sub.toLowerCase()}`);
const statusKey = (sub, kind) =>
  (kind === 'comments' ? `comments:${sub.toLowerCase()}` : sub.toLowerCase());

const WALK_KINDS = ['posts', 'comments'];

const parseTime = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : null;
};

// Most recent sign of life on a status row: real chunk progress (updatedAt,
// written by the worker's markStatus) or the sweep's own last re-enqueue.
// `null` means no readable timestamp at all — treated as stale, because a
// queued walk that has never even stamped a time is the orphan shape at its
// oldest.
function lastActivityMs(status) {
  const a = parseTime(status.updatedAt);
  const b = parseTime(status.sweepRequeuedAt);
  if (a == null && b == null) return null;
  return Math.max(a ?? -Infinity, b ?? -Infinity);
}

// Sweep every configured sub's post and comment walk status; re-enqueue a
// wake-up for each orphaned walk. Returns (and persists, as aggregate
// `backfill-sweep`/`latest`) a summary; every re-enqueue is logged at WARN —
// a self-heal that fires every day is a different bug and must be visible.
async function sweepOrphanedBackfills({
  store, context, subs,
  staleHours = BACKFILL_SWEEP_STALE_HOURS_DEFAULT,
  now = () => Date.now()
} = {}) {
  const staleMs = staleHours * 3600 * 1000;
  const summary = {
    staleHours,
    checked: 0,
    requeued: [],
    skipped: { noHistory: 0, exhausted: 0, notQueued: 0, fresh: 0, unreadable: 0 },
    ranAt: new Date(now()).toISOString()
  };

  for (const sub of subs || []) {
    for (const kind of WALK_KINDS) {
      const key = statusKey(sub, kind);
      let status;
      try {
        status = await store.getAggregate('backfill-status', key);
      } catch (e) {
        summary.skipped.unreadable++;
        context?.warn?.(`backfill sweep: cannot read status for ${key}: ${e.message}`);
        continue;
      }
      summary.checked++;
      if (!status) { summary.skipped.noHistory++; continue; } // new-sub seeding is the daily ingest's job, not the sweep's
      if (status.error) {
        summary.skipped.unreadable++;
        context?.warn?.(`backfill sweep: status row ${key} is unreadable (${status.error}) — skipped, not re-enqueued`);
        continue;
      }
      // NEGATIVE CONTROL: a finished walk is never re-enqueued.
      if (status.exhausted === true) { summary.skipped.exhausted++; continue; }
      if (status.queued !== true) { summary.skipped.notQueued++; continue; }

      const last = lastActivityMs(status);
      if (last != null && now() - last < staleMs) { summary.skipped.fresh++; continue; }

      // Orphaned: the system believes work is outstanding, and nothing has
      // moved for longer than any live chain could go quiet. Re-enqueue the
      // wake-up; the worker resumes from the watermark.
      const months = status.months || 12;
      await store.enqueueBackfill({ sub, months, kind });
      const requeuedAt = new Date(now()).toISOString();
      const nextStatus = {
        ...status,
        sweepRequeuedAt: requeuedAt,
        sweepRequeueCount: (status.sweepRequeueCount || 0) + 1
      };
      // Deliberately does NOT touch status.updatedAt: that field means "the
      // worker made chunk progress", and overwriting it would make a swept-
      // but-still-dead walk look alive.
      await store.saveAggregate('backfill-status', key, nextStatus);
      context?.warn?.(
        `backfill sweep: re-enqueued orphaned ${kind} walk for r/${sub} ` +
        `(watermark=${status.watermark ?? 'none — fresh seed'}, lastActivity=${last != null ? new Date(last).toISOString() : 'never'}, ` +
        `sweepRequeueCount=${nextStatus.sweepRequeueCount})`
      );
      summary.requeued.push({
        sub, kind, months,
        watermark: status.watermark ?? null,
        lastUpdatedAt: status.updatedAt ?? null,
        sweepRequeueCount: nextStatus.sweepRequeueCount
      });
    }
  }

  try {
    await store.saveAggregate('backfill-sweep', 'latest', summary);
  } catch (e) {
    context?.warn?.(`backfill sweep: could not persist summary: ${e.message}`);
  }
  return summary;
}

// Health block for /api/insights?view=health (CB-LISTEN-CORRECT-1 §6):
// walks the system believes are outstanding (`queued: true, exhausted: false`)
// with their staleness and when the sweep last re-enqueued each, plus the
// approximate backfill queue depth (per-sub in-flight state is not readable
// from queue metadata, so depth 0 alongside listed orphans is the
// "self-contradiction" signal: work claimed outstanding, no message anywhere).
//
// REPO-3 pattern: any failure returns an explicit `{ unavailable: true }`
// state, never a confidently-empty block — an empty orphan list is also the
// healthy reading, so an exception rendering as [] would hide the exact
// defect this surface exists to show.
async function orphanHealthBlock({ store, staleHours = BACKFILL_SWEEP_STALE_HOURS_DEFAULT, now = () => Date.now() } = {}) {
  try {
    const [rows, depth, lastSweep] = await Promise.all([
      store.listAggregates('backfill-status'),
      store.queueDepth(store.BACKFILL_QUEUE ?? 'backfill-jobs'),
      store.getAggregate('backfill-sweep', 'latest').catch(() => null)
    ]);
    const staleMs = staleHours * 3600 * 1000;
    const orphans = [];
    let unreadableStatusRows = 0;
    for (const r of rows || []) {
      if (r.error) { unreadableStatusRows++; continue; }
      if (r.exhausted === true || r.queued !== true) continue;
      const period = String(r.period || '');
      const isComments = period.startsWith('comments:');
      const last = lastActivityMs(r);
      orphans.push({
        sub: isComments ? period.slice('comments:'.length) : period,
        kind: isComments ? 'comments' : 'posts',
        watermark: r.watermark ?? null,
        months: r.months ?? null,
        updatedAt: r.updatedAt ?? null,
        sweepRequeuedAt: r.sweepRequeuedAt ?? null,
        sweepRequeueCount: r.sweepRequeueCount ?? 0,
        stale: last == null || now() - last >= staleMs,
        staleForHours: last == null ? null : Math.round((now() - last) / 3600000)
      });
    }
    return {
      staleHours,
      queuedNotExhausted: orphans,
      unreadableStatusRows,
      backfillQueueDepthApprox: depth,
      lastSweep: lastSweep && !lastSweep.error ? lastSweep : null,
      checkedAt: new Date(now()).toISOString()
    };
  } catch (e) {
    return { unavailable: true, error: e.message };
  }
}

module.exports = {
  BACKFILL_SWEEP_STALE_HOURS_DEFAULT,
  WALK_KINDS,
  watermarkKey,
  statusKey,
  sweepOrphanedBackfills,
  orphanHealthBlock
};
