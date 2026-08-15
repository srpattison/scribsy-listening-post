'use strict';

// Dashboard + research API.
//   GET  /api/insights?view=meta|heatmap|stance|distributions|features|minbar|trust|cohort|quotes|personas|brief|all
//   POST /api/ask   { question, filters?: { stance?, topic?, subreddit?, aiOnly? } }
//   POST /api/export            → JSONL of every analyzed row, returns 24h SAS URL
// Function-key auth; CORS is set at the function-app level by deploy.sh.

const { app } = require('@azure/functions');
const store = require('../lib/store');
const { askCorpus, embedTexts, b64ToVec, cosine } = require('../lib/aoai');

const VIEWS = ['meta', 'heatmap', 'stance', 'distributions', 'features', 'minbar', 'trust', 'cohort', 'quotes', 'personas', 'brief', 'competitors', 'resonance', 'signals', 'discovery'];

// Self-reported drain rate + last-rollup outcome. The CLI cannot read this
// account's queue depth (`az storage queue metadata show` returns nothing), so
// the analysis backlog is only observable if the app reports it.
async function health() {
  const [counts, depth, rollup] = await Promise.all([
    store.countPosts().catch((e) => ({ error: e.message })),
    store.queueDepth().catch(() => null),
    store.getAggregate('rollup-health', 'latest').catch((e) => ({ error: e.message }))
  ]);
  return {
    rowsTotal: counts.total ?? null,
    rowsAnalyzed: counts.analyzed ?? null,
    rowsUnanalyzed: counts.unanalyzed ?? null,
    analyzeQueueDepth: depth,
    lastRollupAt: (rollup && rollup.finishedAt) || null,
    lastRollupOk: rollup ? rollup.ok : null,
    lastRollupDurationMs: (rollup && rollup.durationMs) ?? null,
    lastRollupSectionsWritten: (rollup && rollup.sectionsWritten) || [],
    lastRollupSectionsFailed: (rollup && rollup.sectionsFailed) || [],
    lastRollupRowsSkipped: (rollup && rollup.rowsSkipped) ?? null,
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
    score: r.score, numComments: r.numComments, createdUtc: r.createdUtc,
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
    const sample = (ranked || pool.sort((a, b) => (b.score || 0) - (a.score || 0)))
      .slice(0, 300)
      .map((r) => ({
        permalink: r.permalink, subreddit: r.subreddit, score: r.score,
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
