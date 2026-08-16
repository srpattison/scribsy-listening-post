'use strict';

// Dashboard + research API.
//   GET  /api/insights?view=meta|heatmap|stance|distributions|features|minbar|trust|cohort|quotes|personas|brief|all
//   POST /api/ask   { question, filters?: { stance?, topic?, subreddit?, aiOnly? } }
//   POST /api/export            → JSONL of every analyzed row, returns 24h SAS URL
// Function-key auth; CORS is set at the function-app level by deploy.sh.

const { app } = require('@azure/functions');
const store = require('../lib/store');
const config = require('../lib/config');
const boilerplateRegistry = require('../lib/boilerplate-registry');
const { askCorpus, embedTexts, b64ToVec, cosine } = require('../lib/aoai');

const VIEWS = ['meta', 'heatmap', 'stance', 'distributions', 'features', 'minbar', 'trust', 'cohort', 'quotes', 'personas', 'brief', 'competitors', 'resonance', 'signals', 'discovery'];

// Self-reported drain rate + last-rollup outcome. The CLI cannot read this
// account's queue depth (`az storage queue metadata show` returns nothing), so
// the analysis backlog is only observable if the app reports it.
// Sum the prompt-side filter tallies for today and yesterday. Distinguishing
// "filtering works" from "no bot comments were present" is the whole point —
// from the outside they look identical, and the second is what a broken filter
// looks like (§3c).
async function filteredCommentsLast24h() {
  try {
    const rows = (await store.listAggregates('filter-counter')).filter((r) => !r.error);
    const day = 86400000;
    const cutoff = new Date(Date.now() - day).toISOString().slice(0, 10);
    const recent = rows.filter((r) => r.period >= cutoff);
    const byReason = {};
    let total = 0;
    for (const r of recent) {
      total += r.total || 0;
      for (const [k, n] of Object.entries(r.byReason || {})) byReason[k] = (byReason[k] || 0) + n;
    }
    return { total, byReason, days: recent.map((r) => r.period) };
  } catch (e) {
    return { error: e.message };
  }
}

async function health() {
  const [counts, depth, rollup, retagReport, contamination, filtered, registrySummary] = await Promise.all([
    store.countPosts().catch((e) => ({ error: e.message })),
    store.queueDepth().catch(() => null),
    store.getAggregate('rollup-health', 'latest').catch((e) => ({ error: e.message })),
    // Persisted so a severed HTTP response can no longer lose the report (§3d).
    store.getAggregate('retag', 'latest').catch((e) => ({ error: e.message })),
    store.getAggregate('retag-contamination', 'latest').catch((e) => ({ error: e.message })),
    filteredCommentsLast24h(),
    boilerplateRegistry.summarize(store).catch((e) => ({ error: e.message }))
  ]);
  return {
    rowsTotal: counts.total ?? null,
    rowsAnalyzed: counts.analyzed ?? null,
    rowsUnanalyzed: counts.unanalyzed ?? null,
    submissions: counts.posts ?? null,
    comments: counts.comments ?? null,
    commentAnalyzePolicy: config.commentAnalyzePolicy(),
    commentCorpus: (rollup && rollup.commentCorpus) || null,
    analyzeQueueDepth: depth,
    lastRollupAt: (rollup && rollup.finishedAt) || null,
    lastRollupOk: rollup ? rollup.ok : null,
    lastRollupDurationMs: (rollup && rollup.durationMs) ?? null,
    lastRollupSectionsWritten: (rollup && rollup.sectionsWritten) || [],
    lastRollupSectionsFailed: (rollup && rollup.sectionsFailed) || [],
    lastRollupRowsSkipped: (rollup && rollup.rowsSkipped) ?? null,
    // Prompt-side filtering (§3c) and the persisted long-run reports (§3d).
    filteredCommentsLast24h: filtered,
    boilerplateRegistry: registrySummary,
    retag: retagReport && !retagReport.error ? retagReport : null,
    retagContamination: contamination && !contamination.error ? contamination : null,
    checkedAt: new Date().toISOString()
  };
}

app.http('insights', {
  methods: ['GET'],
  authLevel: 'function',
  handler: async (request) => {
    const view = new URL(request.url).searchParams.get('view') || 'all';
    if (view === 'snapshots') {
      // Dated history of the aggregates themselves — trend lines over the answers.
      return { jsonBody: { snapshots: await store.listAggregates('snapshot') } };
    }
    if (view === 'health') {
      return { jsonBody: await health(), headers: { 'Cache-Control': 'no-store' } };
    }
    if (view === 'all') {
      const out = {};
      for (const v of VIEWS) out[v] = await store.getAggregate(v, 'latest');
      out.health = await health();
      return { jsonBody: out, headers: { 'Cache-Control': 'public, max-age=300' } };
    }
    if (!VIEWS.includes(view)) {
      return { status: 400, jsonBody: { error: `view must be one of ${VIEWS.join(', ')}, health, snapshots, or all` } };
    }
    const data = await store.getAggregate(view, 'latest');
    return { jsonBody: data || {}, headers: { 'Cache-Control': 'public, max-age=300' } };
  }
});

function rowToExport(r) {
  let a = null;
  try { a = r.analysisJson ? JSON.parse(r.analysisJson) : null; } catch { /* skip */ }
  return {
    subreddit: r.partitionKey, id: r.rowKey, title: r.title, author: r.author,
    // `kind` is absent on pre-round-4 rows and reads as a submission (§3a.2).
    kind: store.kindOf(r), linkId: r.linkId || null, parentId: r.parentId || null,
    // Capture-time snapshot from Arctic Shift with variable per-row lag. Named
    // so no consumer mistakes it for a current value, and never ranked on.
    scoreAtCapture: r.score, numCommentsAtCapture: r.numComments,
    createdUtc: r.createdUtc,
    permalink: r.permalink, flair: r.flair, schemaVersion: r.schemaVersion || 1,
    emb: r.emb || '', analysis: a
  };
}

app.http('ask', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    let body;
    try { body = await request.json(); } catch { body = {}; }
    const question = (body.question || '').trim();
    if (!question) return { status: 400, jsonBody: { error: 'POST { "question": "…" }' } };
    const f = body.filters || {};

    const rows = (await store.listAnalyzedPosts()).map(rowToExport).filter((r) => r.analysis);
    let pool = rows;
    if (f.aiOnly) pool = pool.filter((r) => r.analysis.ai_related);
    if (f.stance) pool = pool.filter((r) => r.analysis.stance_on_ai === f.stance);
    if (f.topic) pool = pool.filter((r) => (r.analysis.topics || []).includes(f.topic));
    if (f.subreddit) pool = pool.filter((r) => r.subreddit === f.subreddit.toLowerCase());

    // Semantic retrieval: rank the pool by cosine similarity to the question
    // (listening-post embedding index). Falls back to score-ranked when
    // embeddings are unavailable — e.g. rows analyzed before v3.
    let ranked = null;
    try {
      const [qVec] = await embedTexts([question]);
      const withEmb = pool.filter((r) => r.emb);
      if (withEmb.length >= Math.min(50, pool.length)) {
        ranked = withEmb
          .map((r) => ({ r, sim: cosine(qVec, b64ToVec(r.emb)) }))
          .sort((a, b) => b.sim - a.sim)
          .map((x) => x.r);
      }
    } catch (e) {
      context.warn(`semantic retrieval unavailable, falling back to score rank: ${e.message}`);
    }
    // Fallback ordering when embeddings are unavailable is RECENCY, not
    // engagement: `score` is a capture-time snapshot with variable per-row lag
    // and must not rank anything (§3c).
    const sample = (ranked || pool.sort((a, b) => (b.createdUtc || 0) - (a.createdUtc || 0)))
      .slice(0, 300)
      .map((r) => ({
        permalink: r.permalink, subreddit: r.subreddit, kind: r.kind,
        stance: r.analysis.stance_on_ai, basis: r.analysis.stance_basis,
        experience: r.analysis.persona && r.analysis.persona.experience,
        topics: r.analysis.topics, summary: r.analysis.summary,
        quote: r.analysis.notable_quote,
        dealBreakers: (r.analysis.deal_breakers || []).map((d) => d.item),
        trust: (r.analysis.trust_signals || []).map((t) => `${t.direction}:${t.signal}`),
        wishes: (r.analysis.feature_requests || []).map((w) => w.feature)
      }));

    const aggregates = {
      cohort: await store.getAggregate('cohort', 'latest'),
      distributions: await store.getAggregate('distributions', 'latest'),
      poolSize: pool.length,
      sampled: sample.length,
      filters: f
    };
    context.log(`ask: "${question.slice(0, 80)}" pool=${pool.length}`);
    const answer = await askCorpus(question, aggregates, sample);
    return { jsonBody: { question, poolSize: pool.length, sampled: sample.length, ...answer } };
  }
});

app.http('export', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (_request, context) => {
    const rows = (await store.listAnalyzedPosts()).map(rowToExport);
    const url = await store.writeExport(rows.map((r) => JSON.stringify(r)));
    context.log(`export: ${rows.length} rows`);
    return { jsonBody: { rows: rows.length, url, expires: '24h' } };
  }
});

// Liveness probe (anonymous) — also useful as a cheap sustained-usage signal.
app.http('ping', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async () => ({ jsonBody: { ok: true, service: 'scribsy-listening-post', at: new Date().toISOString() } })
});
