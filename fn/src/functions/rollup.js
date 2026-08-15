'use strict';

// Aggregation rollup: recompute dashboard datasets from the posts table.
// Timer daily 13:00 UTC (after ingest+analysis drain) + manual HTTP trigger.
// Persona synthesis + feature normalization call AOAI (weekly-ish work done daily is
// fine — burn is budgeted).

const { app } = require('@azure/functions');
const store = require('../lib/store');
const { synthesizePersonas, normalizeFeatures, strategyBrief, standingQuestions } = require('../lib/aoai');
const { TOPICS, PILLAR_SIGNALS } = require('../lib/taxonomy');

function parseRows(rows) {
  return rows
    .map((r) => {
      let a = null;
      try { a = r.analysisJson ? JSON.parse(r.analysisJson) : null; } catch { /* skip */ }
      if (!a) return null;
      return {
        source: r.source || 'reddit',
        subreddit: r.partitionKey,
        id: r.rowKey,
        title: r.title,
        author: r.author || '',
        permalink: r.permalink,
        score: r.score || 0,
        createdUtc: r.createdUtc,
        week: a.week || '',
        aiRelated: !!a.ai_related,
        stance: a.stance_on_ai || 'na',
        stanceBasis: a.stance_basis || [],
        intensity: a.stance_intensity || 0,
        commentMix: a.comment_stance_mix || null,
        experience: (a.persona && a.persona.experience) || 'unknown',
        personaGoal: (a.persona && a.persona.goal) || '',
        topics: a.topics || [],
        painPoints: a.pain_points || [],
        expectedBaseline: a.expected_baseline || [],
        dealBreakers: a.deal_breakers || [],
        trustSignals: a.trust_signals || [],
        features: a.feature_requests || [],
        ethics: a.ethics_concerns || [],
        tools: (a.tools_mentioned || []).map((t) =>
          typeof t === 'string' ? { tool: t, sentiment: 'neutral', switching: false, context: '' } : t),
        quote: a.notable_quote || '',
        summary: a.summary || ''
      };
    })
    .filter(Boolean);
}

function count(map, key, by = 1) {
  map[key] = (map[key] || 0) + by;
}

async function runRollup(context) {
  const rows = parseRows(await store.listAnalyzedPosts());
  const aiRows = rows.filter((r) => r.aiRelated);
  context.log(`rollup over ${rows.length} analyzed posts (${aiRows.length} AI-related)`);

  // ---- Topic heatmap: topic × week (AI-related only), plus per-subreddit ----
  const weeks = [...new Set(rows.map((r) => r.week).filter(Boolean))].sort();
  const heat = {};
  for (const t of TOPICS) heat[t.slug] = {};
  for (const r of aiRows) for (const t of r.topics) if (heat[t]) count(heat[t], r.week);
  const heatBySub = {};
  for (const r of aiRows) {
    heatBySub[r.subreddit] = heatBySub[r.subreddit] || {};
    for (const t of r.topics) count(heatBySub[r.subreddit], t);
  }

  // ---- Stance trend by week ----
  const stanceByWeek = {};
  for (const r of aiRows) {
    stanceByWeek[r.week] = stanceByWeek[r.week] || {};
    count(stanceByWeek[r.week], r.stance);
  }

  // ---- Distributions ----
  const stances = {}, experience = {}, topicTotals = {}, toolCounts = {}, painCounts = {};
  const stancesBySource = {};
  for (const r of aiRows) {
    stancesBySource[r.source] = stancesBySource[r.source] || {};
    count(stancesBySource[r.source], r.stance);
    count(stances, r.stance);
    count(experience, r.experience);
    for (const t of r.topics) count(topicTotals, t);
    for (const t of r.tools) count(toolCounts, t.tool.trim());
    for (const p of r.painPoints) count(painCounts, p.toLowerCase().trim());
  }
  const topTopics = Object.entries(topicTotals).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // ---- Minimum bar & deal-breakers ----
  const baselineCounts = {}, dbByKind = {}, dbItems = {};
  for (const r of rows) {
    for (const b of r.expectedBaseline) count(baselineCounts, b.toLowerCase().trim());
    for (const d of r.dealBreakers) {
      count(dbByKind, d.kind);
      const k = d.item.toLowerCase().trim();
      dbItems[k] = dbItems[k] || { item: d.item, kind: d.kind, count: 0, examples: [] };
      dbItems[k].count++;
      if (dbItems[k].examples.length < 3) dbItems[k].examples.push({ quote: d.quote, permalink: r.permalink, subreddit: r.subreddit });
    }
  }
  const dealBreakerBoard = Object.values(dbItems).sort((a, b) => b.count - a.count).slice(0, 30);

  // ---- Trust builders / breakers ----
  const trust = { builds: {}, breaks: {} };
  const trustExamples = { builds: {}, breaks: {} };
  for (const r of rows) {
    for (const t of r.trustSignals) {
      const k = t.signal.toLowerCase().trim();
      count(trust[t.direction], k);
      trustExamples[t.direction][k] = trustExamples[t.direction][k] || [];
      if (trustExamples[t.direction][k].length < 3) trustExamples[t.direction][k].push({ quote: t.quote, permalink: r.permalink });
    }
  }
  const trustBoard = {
    builds: Object.entries(trust.builds).sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([signal, n]) => ({ signal, count: n, examples: trustExamples.builds[signal] || [] })),
    breaks: Object.entries(trust.breaks).sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([signal, n]) => ({ signal, count: n, examples: trustExamples.breaks[signal] || [] }))
  };

  // ---- Anti-AI cohort: loud minority vs anxious majority ----
  // Three lenses: share of OP posts, share of distinct authors, and the
  // aggregate stance of COMMENTERS (closer to the silent population).
  // Computed PER SAMPLING FRAME — reddit is the population-representative
  // primary; bluesky skews anti-AI by community composition and is a PR lens.
  function computeCohort(frameRows) {
    const negative = ['hostile', 'wary'];
    const authorStance = {};
    for (const r of frameRows) {
      if (!r.author || r.author === '[deleted]') continue;
      authorStance[r.author] = authorStance[r.author] || {};
      count(authorStance[r.author], r.stance);
    }
    const authors = Object.keys(authorStance);
    const negAuthors = authors.filter((a) => {
      const top = Object.entries(authorStance[a]).sort((x, y) => y[1] - x[1])[0];
      return top && negative.includes(top[0]);
    });
    const commentStanceTotals = {};
    let commentedPosts = 0;
    for (const r of frameRows) {
      if (!r.commentMix) continue;
      commentedPosts++;
      for (const [k, v] of Object.entries(r.commentMix)) count(commentStanceTotals, k, v || 0);
    }
    const basisCounts = {}, basisByStance = { hostile: {}, wary: {}, conflicted: {} };
    let negPosts = 0, negEngagement = 0, totalEngagement = 0, hiIntensityNeg = 0;
    for (const r of frameRows) {
      totalEngagement += r.score;
      if (negative.includes(r.stance) || r.stance === 'conflicted') {
        for (const b of r.stanceBasis) { count(basisCounts, b); count(basisByStance[r.stance] || {}, b); }
      }
      if (negative.includes(r.stance)) {
        negPosts++; negEngagement += r.score;
        if (r.intensity >= 3) hiIntensityNeg++;
      }
    }
    return {
      aiPosts: frameRows.length,
      negPosts,
      negPostShare: frameRows.length ? negPosts / frameRows.length : 0,
      distinctAuthors: authors.length,
      negAuthorShare: authors.length ? negAuthors.length / authors.length : 0,
      negEngagementShare: totalEngagement ? negEngagement / totalEngagement : 0,
      hiIntensityNegShare: negPosts ? hiIntensityNeg / negPosts : 0,
      commentStanceTotals,
      commentedPosts,
      basisCounts,
      basisByStance
    };
  }
  const frames = {};
  for (const src of [...new Set(aiRows.map((r) => r.source))]) {
    frames[src] = computeCohort(aiRows.filter((r) => r.source === src));
  }
  // Primary frame = reddit (population-representative); top-level fields keep
  // the dashboard contract and always describe the primary frame.
  const primary = frames.reddit || frames[Object.keys(frames)[0]] || computeCohort([]);
  const cohort = { ...primary, primaryFrame: frames.reddit ? 'reddit' : Object.keys(frames)[0] || 'none', frames };

  // ---- Feature requests: LLM-normalize into canonical groups ----
  const rawFeatures = [];
  for (const r of rows) {
    for (const f of r.features) {
      rawFeatures.push({ name: f.feature, aiRelated: !!f.ai_related, quote: f.quote, permalink: r.permalink, subreddit: r.subreddit });
    }
  }
  let featureBoard = [];
  if (rawFeatures.length > 0) {
    try {
      const { groups } = await normalizeFeatures(rawFeatures.map((f) => f.name).slice(0, 400));
      featureBoard = groups
        .map((g) => {
          const members = g.members.map((i) => rawFeatures[i]).filter(Boolean);
          const aiVotes = members.filter((m) => m.aiRelated).length;
          return {
            feature: g.canonical,
            count: g.members.length,
            aiRelated: aiVotes * 2 >= members.length && members.length > 0,
            examples: members.slice(0, 3)
          };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 40);
    } catch (e) {
      context.error(`feature normalization failed: ${e.message}`);
      featureBoard = Object.entries(
        rawFeatures.reduce((m, f) => (count(m, f.name.toLowerCase()), m), {})
      ).map(([feature, n]) => ({ feature, count: n, examples: [] }))
        .sort((a, b) => b.count - a.count).slice(0, 25);
    }
  }

  // ---- Quote bank (for the explorer) ----
  const quotes = aiRows
    .filter((r) => r.quote)
    .sort((a, b) => b.score - a.score)
    .slice(0, 400)
    .map((r) => ({
      quote: r.quote, stance: r.stance, experience: r.experience,
      topics: r.topics, subreddit: r.subreddit, permalink: r.permalink,
      title: r.title, week: r.week
    }));

  // ---- Personas (AOAI synthesis) ----
  let personas = null;
  try {
    const sample = aiRows
      .sort((a, b) => b.score - a.score)
      .map((r) => ({ stance: r.stance, experience: r.experience, summary: r.summary, quote: r.quote }));
    personas = await synthesizePersonas(sample, {
      total: aiRows.length, stances, experience, topTopics
    });
  } catch (e) {
    context.error(`persona synthesis failed: ${e.message}`);
    personas = (await store.getAggregate('personas', 'latest')) || { personas: [] };
  }

  // ---- Competitor watch: tool sentiment + switching moments ----
  const toolBoard = {};
  const switchingMoments = [];
  for (const r of rows) {
    for (const t of r.tools) {
      const k = t.tool.trim();
      if (!k) continue;
      toolBoard[k] = toolBoard[k] || { tool: k, mentions: 0, positive: 0, negative: 0, mixed: 0, neutral: 0, switching: 0 };
      toolBoard[k].mentions++;
      count(toolBoard[k], t.sentiment in toolBoard[k] ? t.sentiment : 'neutral');
      if (t.switching) {
        toolBoard[k].switching++;
        if (switchingMoments.length < 60) {
          switchingMoments.push({ tool: k, context: t.context, permalink: r.permalink, subreddit: r.subreddit, week: r.week });
        }
      }
    }
  }
  const competitors = {
    board: Object.values(toolBoard).sort((a, b) => b.mentions - a.mentions).slice(0, 25),
    switchingMoments: switchingMoments.slice(0, 40)
  };

  // ---- Pillar resonance: posts asking for what Scribsy builds ----
  const resonancePosts = [];
  for (const r of rows) {
    let fit = 0;
    const hits = [];
    if (r.topics.includes('provenance-proof')) { fit += 3; hits.push('provenance topic'); }
    if (r.topics.includes('continuity-consistency')) { fit += 2; hits.push('continuity topic'); }
    if (r.topics.includes('detection-accusations')) { fit += 2; hits.push('accusation pain'); }
    if (r.topics.includes('ai-boundaries')) { fit += 1; hits.push('boundaries topic'); }
    const textPool = [
      ...r.features.map((f) => f.feature),
      ...r.trustSignals.map((t) => t.signal),
      ...r.painPoints,
      r.quote
    ].join(' | ');
    for (const [pillar, rx] of Object.entries(PILLAR_SIGNALS)) {
      if (rx.test(textPool)) { fit += 2; hits.push(pillar); }
    }
    if (fit >= 4) {
      resonancePosts.push({
        fit, hits, title: r.title, quote: r.quote, permalink: r.permalink,
        subreddit: r.subreddit, stance: r.stance, experience: r.experience, week: r.week, score: r.score
      });
    }
  }
  const resonance = {
    posts: resonancePosts.sort((a, b) => b.fit - a.fit || b.score - a.score).slice(0, 50),
    totalMatching: resonancePosts.length,
    note: 'Engagement queue: reply as humans, never astroturf; provenance pitch lands best on accusation-pain posts.'
  };

  // ---- Momentum signals: topics accelerating vs trailing 4-week mean ----
  const nowWeek = weeks[weeks.length - 1];
  const prevWeeks = weeks.slice(-5, -1); // trailing 4 full weeks before current
  const spikes = [];
  if (nowWeek && prevWeeks.length === 4) {
    for (const t of TOPICS) {
      const cur = (heat[t.slug] || {})[nowWeek] || 0;
      const mean = prevWeeks.reduce((a, w) => a + ((heat[t.slug] || {})[w] || 0), 0) / 4;
      if (cur >= 5 && cur >= 2 * Math.max(mean, 1)) {
        spikes.push({ topic: t.slug, label: t.label, thisWeek: cur, trailingMean: +mean.toFixed(1), ratio: +(cur / Math.max(mean, 1)).toFixed(1) });
      }
    }
  }
  const signals = { week: nowWeek, spikes: spikes.sort((a, b) => b.ratio - a.ratio), computedAt: new Date().toISOString() };

  // ---- Standing-questions strategy brief (LLM, grounded in the aggregates) ----
  let brief = null;
  try {
    const sampleQuotes = quotes.slice(0, 120);
    brief = await strategyBrief({
      cohort,
      baselineTop: Object.entries(baselineCounts).sort((a, b) => b[1] - a[1]).slice(0, 25),
      dealBreakerBoard: dealBreakerBoard.slice(0, 20),
      dbByKind,
      trustBoard,
      featureBoard: featureBoard.slice(0, 25),
      distributions: { stances, stancesBySource, experience, topTopics, toolCounts: topNObj(toolCounts, 12), painCounts: topNObj(painCounts, 15) },
      personas: personas && personas.personas,
      sampleQuotes
    });
    brief.questions = standingQuestions();
    brief.generatedAt = new Date().toISOString();
  } catch (e) {
    context.error(`strategy brief failed: ${e.message}`);
    brief = (await store.getAggregate('brief', 'latest')) || null;
  }

  const meta = {
    totalPosts: rows.length,
    aiRelated: aiRows.length,
    subreddits: [...new Set(rows.map((r) => r.subreddit))].sort(),
    weeks,
    updatedAt: new Date().toISOString()
  };

  await store.saveAggregate('meta', 'latest', meta);
  await store.saveAggregate('heatmap', 'latest', { weeks, topics: TOPICS, heat, heatBySub });
  await store.saveAggregate('stance', 'latest', { weeks, stanceByWeek, stances });
  await store.saveAggregate('distributions', 'latest', { stances, stancesBySource, experience, topicTotals, toolCounts, painCounts });
  await store.saveAggregate('features', 'latest', { featureBoard });
  await store.saveAggregate('minbar', 'latest', { baselineCounts, dealBreakerBoard, dbByKind });
  await store.saveAggregate('trust', 'latest', trustBoard);
  await store.saveAggregate('cohort', 'latest', cohort);
  await store.saveAggregate('quotes', 'latest', { quotes });
  await store.saveAggregate('personas', 'latest', personas);
  await store.saveAggregate('competitors', 'latest', competitors);
  await store.saveAggregate('resonance', 'latest', resonance);
  await store.saveAggregate('signals', 'latest', signals);
  if (brief) await store.saveAggregate('brief', 'latest', brief);

  // ---- Dated snapshot: trend lines over the answers themselves ----
  const today = new Date().toISOString().slice(0, 10);
  await store.saveAggregate('snapshot', today, {
    totalPosts: rows.length, aiRelated: aiRows.length,
    stances, experience,
    topicTotals: topNObj(topicTotals, 20),
    cohort: {
      negPostShare: cohort.negPostShare, negAuthorShare: cohort.negAuthorShare,
      negEngagementShare: cohort.negEngagementShare, basisCounts: cohort.basisCounts
    },
    spikes: signals.spikes
  });

  // ---- Brain hook: file a digest trace when momentum signals fire ----
  if (process.env.BRAIN_CAPTURE_URL && spikes.length > 0) {
    try {
      const digest = `Listening Post signals ${nowWeek}: ${spikes.map((s) => `${s.label} ×${s.ratio} (${s.thisWeek} posts vs ${s.trailingMean} avg)`).join('; ')}. Cohort: neg OP share ${(cohort.negPostShare * 100).toFixed(0)}%, neg author share ${(cohort.negAuthorShare * 100).toFixed(0)}%. Corpus ${rows.length} posts (${aiRows.length} AI-related). Dashboard: scribsy-insights SWA.`;
      await fetch(process.env.BRAIN_CAPTURE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'text', content: digest, notes: 'Auto-filed by Listening Post rollup (topic spike detected)', domain: 'kb/scribsy' })
      });
      context.log('brain capture posted');
    } catch (e) {
      context.warn(`brain capture failed (non-fatal): ${e.message}`);
    }
  }

  return meta;
}

const topNObj = (m, n) => Object.fromEntries(Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, n));

app.timer('rollupDaily', {
  schedule: '0 0 13 * * *',
  handler: async (_timer, context) => {
    await runRollup(context);
  }
});

app.http('rollupNow', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (_request, context) => {
    return { jsonBody: await runRollup(context) };
  }
});
