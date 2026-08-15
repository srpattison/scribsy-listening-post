'use strict';

// Queue-triggered analysis: one corpus item per message → AOAI classification →
// posts table. Handles both submissions and comments.
//
// Daily spend guardrail: DAILY_ANALYZE_CAP. Comment spend guardrail:
// COMMENT_ANALYZE_POLICY, which ships as `ingest-only` so comments are archived
// but never analyzed until the policy is explicitly widened (§3b).

const { app } = require('@azure/functions');
const store = require('../lib/store');
const config = require('../lib/config');
const commentPolicy = require('../lib/comment-policy');
const { analyzePost, embedTexts, vecToB64 } = require('../lib/aoai');
const { SCHEMA_VERSION, mentionsAi } = require('../lib/taxonomy');

async function underDailyCap(context) {
  const { cap, configError } = config.dailyAnalyzeCap();
  if (configError) context.error(configError); // fail closed and say so — never spend against a guessed ceiling
  const today = new Date().toISOString().slice(0, 10);
  const counter = (await store.getAggregate('analyze-counter', today)) || { count: 0 };
  if (counter.count >= cap) return { ok: false, counter, today, cap, configError };
  return { ok: true, counter, today, cap, configError };
}

// Running tallies so the comment gate is observable without a rollup.
async function bumpCommentCounter(field) {
  const today = new Date().toISOString().slice(0, 10);
  const prev = (await store.getAggregate('comment-gate', today)) || { seen: 0, analyzed: 0, skipped: 0 };
  prev[field] = (prev[field] || 0) + 1;
  if (field !== 'seen') prev.seen = (prev.seen || 0) + 0;
  await store.saveAggregate('comment-gate', today, { ...prev, updatedAt: new Date().toISOString() });
}

app.storageQueue('analyze', {
  queueName: store.ANALYZE_QUEUE,
  connection: 'AzureWebJobsStorage',
  handler: async (message, context) => {
    const job = typeof message === 'string' ? JSON.parse(message) : message;
    const { subreddit, id, created_utc } = job;
    const kind = job.kind === 'comment' ? 'comment' : 'post';

    let raw;
    try {
      raw = await store.getRaw(subreddit, created_utc, id, kind);
    } catch (e) {
      context.error(`raw blob missing for ${subreddit}/${id} (${kind}): ${e.message}`);
      return; // nothing to analyze; don't poison-loop
    }

    // ---- comment gate: decided BEFORE the daily cap, so a skipped comment
    // never consumes a slot and never defers a submission. ----
    if (kind === 'comment') {
      const policy = config.commentAnalyzePolicy();
      const minChars = config.commentMinChars();
      const body = (raw.post && raw.post.selftext) || '';
      let parentAiRelated = false;
      const linkId = raw.post && raw.post.linkId;
      if (policy === 'policy' && linkId) {
        try {
          const parent = await store.getPostRow(subreddit, linkId);
          parentAiRelated = !!(parent && parent.aiRelated);
        } catch { /* unknown parent → predicate falls back to the body test */ }
      }
      const decision = commentPolicy.shouldAnalyze(
        { body, bodyChars: body.length, aiPrefilterHit: mentionsAi(body) },
        { policy, parentAiRelated, minChars }
      );
      if (!decision.selected) {
        await bumpCommentCounter('skipped').catch(() => {});
        context.log(`comment ${subreddit}/${id} not analyzed (policy=${policy}, reason=${decision.reason})`);
        return; // archived in `raw`, re-analyzable later via /api/reanalyze
      }
    }

    const cap = await underDailyCap(context);
    if (!cap.ok) {
      // Over cap (or cap unconfigured): re-enqueue with a 6h visibility delay
      // rather than losing the job.
      context.warn(`analyze cap reached (cap=${cap.cap}) — deferring ${subreddit}/${id} 6h`);
      await store.enqueueAnalysis(job, 6 * 3600);
      return;
    }

    const analysis = await analyzePost(raw.post, raw.comments || []);

    // Subreddit-mention extraction (regex, zero LLM cost) — feeds the discovery
    // view. Comments have this extracted at ingest, because their analysis is
    // gated and may never run.
    const mentionText = [raw.post.title, raw.post.selftext, ...(raw.comments || []).map((c) => c.body)].join('\n');
    const mentions = new Set();
    for (const m of mentionText.matchAll(/\br\/([A-Za-z0-9_]{3,21})\b/g)) {
      const name = m[1].toLowerCase();
      if (name !== subreddit.toLowerCase()) mentions.add(name);
    }

    // Semantic index vector (listening-post-only embedding system).
    let embB64 = '';
    try {
      const text = `${raw.post.title}\n${analysis.summary}\n${analysis.notable_quote}\n${(analysis.topics || []).join(' ')}`.slice(0, 6000);
      const [vec] = await embedTexts([text]);
      embB64 = vecToB64(vec);
    } catch (e) {
      context.warn(`embedding failed for ${subreddit}/${id} (non-fatal): ${e.message}`);
    }

    await store.saveAnalysis(subreddit, id, analysis, {
      embB64,
      schemaVersion: SCHEMA_VERSION,
      subMentionsCsv: [...mentions].slice(0, 30).join(','),
      kind
    });
    await store.saveAggregate('analyze-counter', cap.today, { count: cap.counter.count + 1 });
    if (kind === 'comment') await bumpCommentCounter('analyzed').catch(() => {});
    context.log(`analyzed ${kind} ${subreddit}/${id} v${SCHEMA_VERSION} ai=${analysis.ai_related} stance=${analysis.stance_on_ai}`);
  }
});
