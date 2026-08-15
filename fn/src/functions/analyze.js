'use strict';

// Queue-triggered analysis: one Reddit post per message → AOAI classification → posts table.
// Daily spend guardrail: DAILY_ANALYZE_CAP (default 1500 posts/day).

const { app } = require('@azure/functions');
const store = require('../lib/store');
const { analyzePost, embedTexts, vecToB64 } = require('../lib/aoai');
const { SCHEMA_VERSION } = require('../lib/taxonomy');

async function underDailyCap() {
  const cap = parseInt(process.env.DAILY_ANALYZE_CAP || '1500', 10);
  const today = new Date().toISOString().slice(0, 10);
  const counter = (await store.getAggregate('analyze-counter', today)) || { count: 0 };
  if (counter.count >= cap) return { ok: false, counter, today };
  return { ok: true, counter, today };
}

app.storageQueue('analyze', {
  queueName: store.ANALYZE_QUEUE,
  connection: 'AzureWebJobsStorage',
  handler: async (message, context) => {
    const job = typeof message === 'string' ? JSON.parse(message) : message;
    const { subreddit, id, created_utc } = job;

    const cap = await underDailyCap();
    if (!cap.ok) {
      // Over cap: re-enqueue with a 6h visibility delay rather than losing the
      // job (immediate re-enqueue would spin the queue all day).
      context.warn(`daily analyze cap hit — deferring ${subreddit}/${id} 6h`);
      await store.enqueueAnalysis(job, 6 * 3600);
      return;
    }

    let raw;
    try {
      raw = await store.getRaw(subreddit, created_utc, id);
    } catch (e) {
      context.error(`raw blob missing for ${subreddit}/${id}: ${e.message}`);
      return; // nothing to analyze; don't poison-loop
    }

    const analysis = await analyzePost(raw.post, raw.comments || []);

    // Subreddit-mention extraction (regex, zero LLM cost) — feeds the
    // discovery view: candidate subs cited by the communities we track.
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
      subMentionsCsv: [...mentions].slice(0, 30).join(',')
    });
    await store.saveAggregate('analyze-counter', cap.today, { count: cap.counter.count + 1 });
    context.log(`analyzed ${subreddit}/${id} v${SCHEMA_VERSION} ai=${analysis.ai_related} stance=${analysis.stance_on_ai}`);
  }
});
