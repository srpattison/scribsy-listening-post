'use strict';

// Rollup engine — the aggregation logic, isolated from the Azure Functions host
// so it can be unit-tested with fake dependencies (see fn/test/).
//
// ROUND 3 CONTRACT: no single section may prevent a later section from being
// written, and no single row may abort the section it appears in.
//
// Before this round every section was computed inline and the fifteen writes
// happened in one unguarded sequence at the end of the function. The first
// write that threw — `distributions`, whose unbounded toolCounts/painCounts maps
// blew the Table Storage property cap — aborted the run, leaving the three
// sections ahead of it written and the twelve behind it absent. The dashboard
// then read twelve nulls and rendered them as "no data yet".
//
// Now: each section owns a try/catch, a failure writes {error, failedAt} into
// that section's own row, and the run continues. A section that depends on an
// earlier one reads it from `results` and must tolerate it being missing.

const { TOPICS, PILLAR_SIGNALS } = require('./taxonomy');
const config = require('./config');
const commentPolicy = require('./comment-policy');
const contentClass = require('./content-class');
const boilerplateRegistry = require('./boilerplate-registry');

// ---------------------------------------------------------------------------
// Salience — corpus-derived, never engagement-derived (§3c)
// ---------------------------------------------------------------------------
//
// `score` and `numComments` come from Arctic Shift's near-creation snapshot and
// are never backfilled. Capture lag varies per row (35% of rows sit at score 1,
// 32% at 0 comments), so the numbers look like genuine variance but are mostly
// capture timing — and the lag plausibly correlates with subreddit size and
// archive era, so the injected error is not even random. Nothing here may
// weight, rank, sort or threshold on them.
//
// Where ranking is genuinely needed, salience is how often a row's claims RECUR
// across independent threads: a concern raised in twenty threads outranks one
// raised in a single popular one, which is the question we actually care about.
function buildRecurrenceIndex(rows) {
  const topicThreads = {}, painThreads = {};
  const add = (map, key, thread) => {
    if (!key) return;
    (map[key] = map[key] || new Set()).add(thread);
  };
  for (const r of rows) {
    const thread = r.threadId || r.id;
    for (const t of r.topics || []) add(topicThreads, t, thread);
    for (const p of r.painPoints || []) add(painThreads, String(p || '').toLowerCase().trim(), thread);
  }
  const counts = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.size]));
  return { topics: counts(topicThreads), pains: counts(painThreads) };
}

// Distinct-thread recurrence of a row's claims. Deterministic, engagement-free.
function salienceOf(row, index) {
  let s = 0;
  for (const t of row.topics || []) s += index.topics[t] || 0;
  for (const p of row.painPoints || []) s += index.pains[String(p || '').toLowerCase().trim()] || 0;
  return s;
}

// Stable ordering: salience desc, then oldest-first, then id — so equal-salience
// rows do not reshuffle between runs.
const bySalience = (index) => (a, b) =>
  salienceOf(b, index) - salienceOf(a, index) ||
  (a.createdUtc || 0) - (b.createdUtc || 0) ||
  String(a.id).localeCompare(String(b.id));

// ---------------------------------------------------------------------------
// Row parsing — per-row isolation (§4.2)
// ---------------------------------------------------------------------------

// Returns { items, skipped }. A row with unparseable analysisJson, or one whose
// shape trips the mapper, is counted and dropped — never thrown.
function parseRows(rows) {
  const items = [];
  let skipped = 0;
  for (const r of rows || []) {
    let a = null;
    try {
      a = r.analysisJson ? JSON.parse(r.analysisJson) : null;
    } catch {
      skipped++;
      continue;
    }
    if (!a) { skipped++; continue; }
    try {
      items.push({
        source: r.source || 'reddit',
        // `kind` is absent on every pre-round-4 row; missing means submission.
        kind: r.kind === 'comment' ? 'comment' : 'post',
        threadId: r.linkId || r.rowKey, // comments group under their submission
        parentId: r.parentId || null,
        subreddit: r.partitionKey,
        id: r.rowKey,
        title: r.title,
        author: r.author || '',
        permalink: r.permalink,
        // Renamed on read so no future consumer mistakes a capture-time
        // snapshot for a current value. Stored, displayed, never ranked on.
        scoreAtCapture: r.score || 0,
        numCommentsAtCapture: r.numComments || 0,
        createdUtc: r.createdUtc,
        // Bot/boilerplate tag. Absent on rows not yet retagged, which reads as
        // `human`; runRollup applies a fallback classification so an untagged
        // corpus is still filtered (§3c).
        contentClass: r.contentClass || null,
        contentClassReason: r.contentClassReason || '',
        distinguished: r.distinguished || null,
        stickied: r.stickied === true,
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
        summary: a.summary || '',
        subMentions: r.subMentionsCsv ? String(r.subMentionsCsv).split(',').filter(Boolean) : []
      });
    } catch {
      skipped++;
    }
  }
  return { items, skipped };
}

// Iterate rows so that one malformed row cannot abort the whole section.
// `tally` accumulates per-section skip counts.
function forEachRow(rows, fn, tally) {
  for (const r of rows) {
    try {
      fn(r);
    } catch (e) {
      tally.rowErrors++;
      if (!tally.firstRowError) tally.firstRowError = e.message;
    }
  }
}

function count(map, key, by = 1) {
  if (key === undefined || key === null) return;
  map[key] = (map[key] || 0) + by;
}

const topNObj = (m, n) => Object.fromEntries(Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, n));

// Apply the bot/boilerplate detectors to rows that carry no stored
// `contentClass`. A row already tagged by POST /api/retag keeps its tag; an
// untagged row is classified from the columns the rollup can see. Title
// repeat-hash works here because scheduled megathreads repeat their titles
// verbatim; body hashing needs the raw archive and belongs to retag.
function classifyUntagged(rows, env = process.env) {
  const opts = {
    minRepeats: config.boilerplateMinRepeats(env),
    minChars: config.boilerplateMinCharsBody(env),
    minTitleChars: config.boilerplateMinCharsTitle(env)
  };
  const untagged = rows.filter((r) => !r.contentClass);
  if (!untagged.length) return rows;
  const index = contentClass.buildRepeatIndex(
    untagged.map((r) => ({ subreddit: r.subreddit, title: r.title, body: '' })),
    opts
  );
  return rows.map((r) => {
    if (r.contentClass) return r;
    const c = contentClass.classifyRow(
      { author: r.author, title: r.title, body: '', subreddit: r.subreddit, distinguished: r.distinguished, stickied: r.stickied },
      index,
      opts
    );
    return { ...r, contentClass: c.contentClass, contentClassReason: c.contentClassReason };
  });
}

// ---------------------------------------------------------------------------
// Section runner — per-section isolation (§4.1)
// ---------------------------------------------------------------------------

// Runs sections in order. Each gets its own try/catch; a thrown section writes
// an error row and the run continues to the next. Results of successful
// sections are passed forward so dependents can read them.
//
// This function is the point of round 3: deleting the try/catch below makes
// fn/test/rollup-isolation.test.js fail.
async function runSections(sections, { saveAggregate, context, now = () => new Date() }) {
  const results = {};
  const written = [];
  const failed = [];
  const rowIssues = {};

  for (const section of sections) {
    const tally = { rowErrors: 0, firstRowError: null };
    try {
      const payload = await section.build(results, tally);
      await saveAggregate(section.partition || section.name, section.period || 'latest', payload);
      results[section.name] = payload;
      written.push(section.name);
      if (tally.rowErrors) {
        rowIssues[section.name] = { rowErrors: tally.rowErrors, firstRowError: tally.firstRowError };
        context?.warn?.(`rollup section ${section.name}: skipped ${tally.rowErrors} bad row(s) — ${tally.firstRowError}`);
      }
    } catch (e) {
      const entry = { name: section.name, error: e && e.message ? e.message : String(e) };
      failed.push(entry);
      context?.error?.(`rollup section ${section.name} failed: ${entry.error}`);
      // The failure itself must be persisted, so /api/insights reports a named
      // error instead of a null the dashboard would render as "no data".
      try {
        await saveAggregate(section.partition || section.name, section.period || 'latest', {
          error: entry.error,
          failedAt: now().toISOString()
        });
      } catch (e2) {
        entry.alsoFailedToRecord = e2 && e2.message ? e2.message : String(e2);
        context?.error?.(`rollup section ${section.name}: could not record failure: ${entry.alsoFailedToRecord}`);
      }
    }
  }
  return { results, written, failed, rowIssues };
}

// ---------------------------------------------------------------------------
// Section definitions
// ---------------------------------------------------------------------------

function computeCohort(frameRows, tally) {
  const negative = ['hostile', 'wary'];
  const authorStance = {};
  forEachRow(frameRows, (r) => {
    if (!r.author || r.author === '[deleted]') return;
    authorStance[r.author] = authorStance[r.author] || {};
    count(authorStance[r.author], r.stance);
  }, tally);
  const authors = Object.keys(authorStance);
  const negAuthors = authors.filter((a) => {
    const top = Object.entries(authorStance[a]).sort((x, y) => y[1] - x[1])[0];
    return top && negative.includes(top[0]);
  });
  const commentStanceTotals = {};
  let commentedPosts = 0;
  forEachRow(frameRows, (r) => {
    if (!r.commentMix) return;
    commentedPosts++;
    for (const [k, v] of Object.entries(r.commentMix)) count(commentStanceTotals, k, v || 0);
  }, tally);
  const basisCounts = {}, basisByStance = { hostile: {}, wary: {}, conflicted: {} };
  let negPosts = 0, hiIntensityNeg = 0;
  const negThreads = new Set(), allThreads = new Set();
  forEachRow(frameRows, (r) => {
    allThreads.add(r.threadId || r.id);
    if (negative.includes(r.stance) || r.stance === 'conflicted') {
      for (const b of r.stanceBasis) { count(basisCounts, b); count(basisByStance[r.stance] || {}, b); }
    }
    if (negative.includes(r.stance)) {
      negPosts++;
      negThreads.add(r.threadId || r.id);
      if (r.intensity >= 3) hiIntensityNeg++;
    }
  }, tally);
  return {
    aiPosts: frameRows.length,
    negPosts,
    negPostShare: frameRows.length ? negPosts / frameRows.length : 0,
    distinctAuthors: authors.length,
    negAuthorShare: authors.length ? negAuthors.length / authors.length : 0,
    // Replaces the former negEngagementShare, which weighted by `score` — an
    // Arctic Shift capture-time snapshot with variable per-row lag (§3c).
    // Thread spread is corpus-derived: how many distinct conversations carry a
    // negative voice, not how many upvotes the archiver happened to catch.
    negThreadShare: allThreads.size ? negThreads.size / allThreads.size : 0,
    distinctThreads: allThreads.size,
    hiIntensityNegShare: negPosts ? hiIntensityNeg / negPosts : 0,
    commentStanceTotals,
    commentedPosts,
    basisCounts,
    basisByStance
  };
}

// Builds the ordered section list. Order is preserved from the pre-round-3
// write sequence so the on-storage layout is unchanged.
// SENTIMENT SECTIONS READ `humanRows` / `humanAiRows` ONLY.
//
// Bot and boilerplate rows stay in the corpus (they are tagged, never deleted)
// and remain visible in `meta`, `heatmap` and the `rules` frame — but they must
// never reach a stance, quote, persona, trust, minbar, features, resonance,
// signals, cohort, distributions or competitors aggregate. Subreddit rule text
// repeated on a schedule is not a writer's position, and counting it biases the
// corpus toward appearing anti-AI.
//
// fn/test/bot-boilerplate.test.js greps this file to assert no sentiment section
// references the unfiltered `rows` / `aiRows`, and that assertion is verified to
// fail against 3562788.
function buildSections({
  rows, aiRows, humanRows, humanAiRows, nonHumanRows,
  weeks, env, aoai, store, context, now = () => new Date(),
  commentMentions = [], commentStats = null
}) {
  const salience = buildRecurrenceIndex(humanRows);
  return [
    {
      // meta counts EVERYTHING, but never as one blended number: bot and
      // boilerplate rows are reported separately so the corpus size is honest
      // about what fraction of it is not writer sentiment.
      name: 'meta',
      build: () => ({
        totalPosts: humanRows.length,
        totalRowsIncludingNonHuman: rows.length,
        aiRelated: humanAiRows.length,
        nonHuman: {
          total: nonHumanRows.length,
          bot: nonHumanRows.filter((r) => r.contentClass === 'bot').length,
          boilerplate: nonHumanRows.filter((r) => r.contentClass === 'boilerplate').length,
          byReason: nonHumanRows.reduce((m, r) => (count(m, r.contentClassReason || 'unknown'), m), {}),
          note: 'Tagged, never deleted. Excluded from every sentiment aggregate; reported in the `rules` frame.'
        },
        submissions: humanRows.filter((r) => r.kind === 'post').length,
        comments: humanRows.filter((r) => r.kind === 'comment').length,
        commentCorpus: commentStats, // ingested vs analyzed, incl. the policy dry run
        subreddits: [...new Set(humanRows.map((r) => r.subreddit))].sort(),
        weeks,
        engagementNote: 'score/numComments are an Arctic Shift capture-time snapshot with variable per-row lag. Surfaced as scoreAtCapture/numCommentsAtCapture; nothing ranks on them.',
        updatedAt: now().toISOString()
      })
    },
    {
      name: 'heatmap',
      build: (_r, tally) => {
        const heat = {};
        for (const t of TOPICS) heat[t.slug] = {};
        forEachRow(humanAiRows, (r) => {
          for (const t of r.topics) if (heat[t]) count(heat[t], r.week);
        }, tally);
        const heatBySub = {};
        forEachRow(humanAiRows, (r) => {
          heatBySub[r.subreddit] = heatBySub[r.subreddit] || {};
          for (const t of r.topics) count(heatBySub[r.subreddit], t);
        }, tally);
        return { weeks, topics: TOPICS, heat, heatBySub };
      }
    },
    {
      name: 'stance',
      build: (_r, tally) => {
        const stanceByWeek = {}, stances = {};
        forEachRow(humanAiRows, (r) => {
          stanceByWeek[r.week] = stanceByWeek[r.week] || {};
          count(stanceByWeek[r.week], r.stance);
          count(stances, r.stance);
        }, tally);
        return { weeks, stanceByWeek, stances };
      }
    },
    {
      name: 'distributions',
      build: (_r, tally) => {
        const stances = {}, experience = {}, topicTotals = {}, toolCounts = {}, painCounts = {};
        const stancesBySource = {};
        forEachRow(humanAiRows, (r) => {
          stancesBySource[r.source] = stancesBySource[r.source] || {};
          count(stancesBySource[r.source], r.stance);
          count(stances, r.stance);
          count(experience, r.experience);
          for (const t of r.topics) count(topicTotals, t);
          for (const t of r.tools) count(toolCounts, String(t.tool || '').trim());
          for (const p of r.painPoints) count(painCounts, String(p || '').toLowerCase().trim());
        }, tally);
        // Long tails are capped here rather than at write time: an unbounded map
        // over every distinct pain string is what pushed this row past the
        // Table Storage property cap and aborted the whole rollup.
        return {
          stances,
          stancesBySource,
          experience,
          topicTotals,
          toolCounts: topNObj(toolCounts, 400),
          painCounts: topNObj(painCounts, 400),
          toolCountsTotal: Object.keys(toolCounts).length,
          painCountsTotal: Object.keys(painCounts).length
        };
      }
    },
    {
      name: 'features',
      build: async (_r, tally) => {
        const rawFeatures = [];
        forEachRow(humanRows, (r) => {
          for (const f of r.features) {
            rawFeatures.push({ name: f.feature, aiRelated: !!f.ai_related, quote: f.quote, permalink: r.permalink, subreddit: r.subreddit });
          }
        }, tally);
        if (!rawFeatures.length) return { featureBoard: [] };
        try {
          const { groups } = await aoai.normalizeFeatures(rawFeatures.map((f) => f.name).slice(0, 400));
          const featureBoard = groups
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
          return { featureBoard };
        } catch (e) {
          // Degrade to raw counts rather than failing the section outright.
          context?.error?.(`feature normalization failed: ${e.message}`);
          const featureBoard = Object.entries(
            rawFeatures.reduce((m, f) => (count(m, String(f.name || '').toLowerCase()), m), {})
          ).map(([feature, n]) => ({ feature, count: n, examples: [] }))
            .sort((a, b) => b.count - a.count).slice(0, 25);
          return { featureBoard, degraded: true, degradedReason: e.message };
        }
      }
    },
    {
      name: 'minbar',
      build: (_r, tally) => {
        const baselineCounts = {}, dbByKind = {}, dbItems = {};
        forEachRow(humanRows, (r) => {
          for (const b of r.expectedBaseline) count(baselineCounts, String(b || '').toLowerCase().trim());
          for (const d of r.dealBreakers) {
            count(dbByKind, d.kind);
            const k = String(d.item || '').toLowerCase().trim();
            dbItems[k] = dbItems[k] || { item: d.item, kind: d.kind, count: 0, examples: [] };
            dbItems[k].count++;
            if (dbItems[k].examples.length < 3) dbItems[k].examples.push({ quote: d.quote, permalink: r.permalink, subreddit: r.subreddit });
          }
        }, tally);
        return {
          baselineCounts: topNObj(baselineCounts, 400),
          dealBreakerBoard: Object.values(dbItems).sort((a, b) => b.count - a.count).slice(0, 30),
          dbByKind
        };
      }
    },
    {
      name: 'trust',
      build: (_r, tally) => {
        const trust = { builds: {}, breaks: {} };
        const trustExamples = { builds: {}, breaks: {} };
        forEachRow(humanRows, (r) => {
          for (const t of r.trustSignals) {
            if (!trust[t.direction]) continue; // unknown direction — skip, don't throw
            const k = String(t.signal || '').toLowerCase().trim();
            count(trust[t.direction], k);
            trustExamples[t.direction][k] = trustExamples[t.direction][k] || [];
            if (trustExamples[t.direction][k].length < 3) trustExamples[t.direction][k].push({ quote: t.quote, permalink: r.permalink });
          }
        }, tally);
        return {
          builds: Object.entries(trust.builds).sort((a, b) => b[1] - a[1]).slice(0, 20)
            .map(([signal, n]) => ({ signal, count: n, examples: trustExamples.builds[signal] || [] })),
          breaks: Object.entries(trust.breaks).sort((a, b) => b[1] - a[1]).slice(0, 20)
            .map(([signal, n]) => ({ signal, count: n, examples: trustExamples.breaks[signal] || [] }))
        };
      }
    },
    {
      name: 'cohort',
      build: (_r, tally) => {
        // Frame assignment: bluesky is its own frame; Reddit subs split by
        // SUB_TAGS. Enclave subs are deliberately skewed communities — kept as
        // comparison frames so adding them never shifts the population numbers.
        // Throws if SUB_TAGS is unset: an empty tag map would silently pool
        // deliberately skewed enclave subs into the population cohort (§9.1).
        const subTags = config.subTags(env);
        // Bluesky streams split by kind. `topic` streams are keyword searches ON
        // the subject under study; `community` streams are unfiltered writer
        // samples. Pooling them would manufacture the exact answer standing
        // question 5 asks for, so they are separate frames (§8).
        const streamKinds = config.bskyStreamKinds(env);
        const tagOf = (r) => {
          if (r.source === 'bluesky') {
            const k = streamKinds[r.subreddit];
            if (k === 'community') return 'bluesky-community';
            if (k === 'topic') return 'bluesky-topic';
            return 'bluesky-untagged'; // stream not in BSKY_STREAMS — never pooled into either
          }
          const t = subTags[r.subreddit] || subTags[Object.keys(subTags).find((k) => k.toLowerCase() === r.subreddit) || ''];
          return t ? `reddit-${t}` : 'reddit';
        };
        const frames = {};
        forEachRow(humanAiRows, (r) => {
          const f = tagOf(r);
          (frames[f] = frames[f] || []).push(r);
        }, tally);
        for (const f of Object.keys(frames)) frames[f] = computeCohort(frames[f], tally);
        const primary = frames.reddit || frames[Object.keys(frames)[0]] || computeCohort([], tally);
        return {
          ...primary,
          primaryFrame: frames.reddit ? 'reddit (general subs)' : Object.keys(frames)[0] || 'none',
          frames,
          frameNote: 'Frames are never pooled. Reddit general subs are the population-representative primary; enclave subs and Bluesky topic streams are keyword- or community-selected and cannot answer population questions. bluesky-community is the only unfiltered Bluesky writer sample.'
        };
      }
    },
    {
      name: 'quotes',
      build: (_r, tally) => {
        const picked = [];
        forEachRow(humanAiRows, (r) => { if (r.quote) picked.push(r); }, tally);
        return {
          quotes: picked
            .sort(bySalience(salience))
            .slice(0, 400)
            .map((r) => ({
              quote: r.quote, stance: r.stance, experience: r.experience,
              topics: r.topics, subreddit: r.subreddit, permalink: r.permalink,
              title: r.title, week: r.week, kind: r.kind
            })),
          ranking: 'recurrence across distinct threads — never Reddit engagement'
        };
      }
    },
    {
      name: 'personas',
      build: async (results) => {
        const dist = results.distributions || {};
        try {
          const sample = humanAiRows
            .slice()
            .sort(bySalience(salience))
            .map((r) => ({ stance: r.stance, experience: r.experience, summary: r.summary, quote: r.quote }));
          return await aoai.synthesizePersonas(sample, {
            total: humanAiRows.length,
            stances: dist.stances || {},
            experience: dist.experience || {},
            topTopics: Object.entries(dist.topicTotals || {}).sort((a, b) => b[1] - a[1]).slice(0, 10)
          });
        } catch (e) {
          // Keep the last good synthesis rather than blanking the panel, but
          // mark it stale so the dashboard can say so.
          context?.error?.(`persona synthesis failed: ${e.message}`);
          const prev = await store.getAggregate('personas', 'latest');
          if (prev && !prev.error) return { ...prev, _stale: true, _staleReason: e.message };
          return { personas: [], _stale: true, _staleReason: e.message };
        }
      }
    },
    {
      name: 'competitors',
      build: (_r, tally) => {
        const toolBoard = {};
        const switchingMoments = [];
        forEachRow(humanRows, (r) => {
          for (const t of r.tools) {
            const k = String(t.tool || '').trim();
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
        }, tally);
        return {
          board: Object.values(toolBoard).sort((a, b) => b.mentions - a.mentions).slice(0, 25),
          switchingMoments: switchingMoments.slice(0, 40)
        };
      }
    },
    {
      name: 'resonance',
      build: (_r, tally) => {
        const resonancePosts = [];
        forEachRow(humanRows, (r) => {
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
              subreddit: r.subreddit, stance: r.stance, experience: r.experience, week: r.week,
              kind: r.kind,
              salience: salienceOf(r, salience),
              scoreAtCapture: r.scoreAtCapture // displayed with a capture-time label, never ranked on
            });
          }
        }, tally);
        return {
          posts: resonancePosts.sort((a, b) => b.fit - a.fit || b.salience - a.salience).slice(0, 50),
          totalMatching: resonancePosts.length,
          note: 'Engagement queue: reply as humans, never astroturf; provenance pitch lands best on accusation-pain posts.',
          ranking: 'pillar fit, then recurrence across distinct threads — never Reddit engagement'
        };
      }
    },
    {
      name: 'signals',
      build: (results) => {
        const heat = (results.heatmap && results.heatmap.heat) || {};
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
        return { week: nowWeek, spikes: spikes.sort((a, b) => b.ratio - a.ratio), computedAt: now().toISOString() };
      }
    },
    {
      name: 'discovery',
      build: (_r, tally) => {
        const tracked = new Set(
          (env.SUBREDDITS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        );
        for (const r of humanRows) tracked.add(r.subreddit); // anything we already ingest
        const NOISE = new Set(['all', 'askreddit', 'popular', 'funny', 'pics', 'memes', 'aita', 'amitheasshole']);
        const mentionCounts = {}, mentionedBy = {};
        const tally1 = (sub, mentions) => {
          for (const m of mentions) {
            if (!m || tracked.has(m) || NOISE.has(m)) continue;
            count(mentionCounts, m);
            (mentionedBy[m] = mentionedBy[m] || new Set()).add(sub);
          }
        };
        forEachRow(humanRows, (r) => tally1(r.subreddit, r.subMentions), tally);
        // Comment mentions come straight from the ingest-time extraction, so
        // discovery works even under the ingest-only comment policy — the
        // runbook always claimed r/Sub extraction ran over comments, and until
        // round 4 there were no comments for it to run over (§3a.7).
        forEachRow(commentMentions, (c) => tally1(c.subreddit, c.mentions), tally);
        return {
          candidates: Object.entries(mentionCounts)
            .filter(([, n]) => n >= 3)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 40)
            .map(([name, n]) => ({ sub: name, mentions: n, citedBy: [...mentionedBy[name]].slice(0, 6) })),
          note: 'Subs cited >=3 times by tracked communities and not yet ingested. Vet before adding: writer-side? active? enclave tag needed?',
          sources: { analyzedRows: humanRows.length, commentRows: commentMentions.length }
        };
      }
    },
    {
      // What the excluded boilerplate actually SAYS, per sub. The rule text is
      // not sentiment, but it is real evidence about community norms — which
      // communities have formally banned AI assistance, and in what terms —
      // and it is directly relevant to the trust question. Kept as its own
      // frame precisely so it is never pooled with writer voices.
      name: 'rules',
      build: (_r, tally) => {
        const bySub = {};
        forEachRow(nonHumanRows, (r) => {
          const b = bySub[r.subreddit] || (bySub[r.subreddit] = { subreddit: r.subreddit, rows: 0, byReason: {}, samples: [] });
          b.rows++;
          count(b.byReason, r.contentClassReason || 'unknown');
          const text = (r.quote || r.summary || r.title || '').trim();
          if (text && b.samples.length < 5 && !b.samples.some((s) => s.text === text)) {
            b.samples.push({ text: text.slice(0, 400), permalink: r.permalink, reason: r.contentClassReason });
          }
        }, tally);
        return {
          subs: Object.values(bySub).sort((a, b) => b.rows - a.rows),
          totalExcluded: nonHumanRows.length,
          note: 'Bot and boilerplate rows, excluded from every sentiment aggregate. What a subreddit formally prohibits is evidence about community norms — it is not a writer position.'
        };
      }
    },
    {
      name: 'brief',
      build: async (results) => {
        const dist = results.distributions || {};
        const minbar = results.minbar || {};
        try {
          const brief = await aoai.strategyBrief({
            cohort: results.cohort || {},
            baselineTop: Object.entries(minbar.baselineCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 25),
            dealBreakerBoard: (minbar.dealBreakerBoard || []).slice(0, 20),
            dbByKind: minbar.dbByKind || {},
            trustBoard: results.trust || {},
            featureBoard: ((results.features && results.features.featureBoard) || []).slice(0, 25),
            distributions: {
              stances: dist.stances || {},
              stancesBySource: dist.stancesBySource || {},
              experience: dist.experience || {},
              topTopics: Object.entries(dist.topicTotals || {}).sort((a, b) => b[1] - a[1]).slice(0, 10),
              toolCounts: topNObj(dist.toolCounts, 12),
              painCounts: topNObj(dist.painCounts, 15)
            },
            personas: results.personas && results.personas.personas,
            sampleQuotes: ((results.quotes && results.quotes.quotes) || []).slice(0, 120)
          });
          brief.questions = aoai.standingQuestions();
          brief.generatedAt = now().toISOString();
          return brief;
        } catch (e) {
          context?.error?.(`strategy brief failed: ${e.message}`);
          const prev = await store.getAggregate('brief', 'latest');
          if (prev && !prev.error) return { ...prev, _stale: true, _staleReason: e.message };
          return { answers: [], questions: aoai.standingQuestions(), _stale: true, _staleReason: e.message };
        }
      }
    },
    {
      // Dated snapshot: trend lines over the answers themselves.
      name: 'snapshot',
      period: now().toISOString().slice(0, 10),
      build: (results) => {
        const dist = results.distributions || {};
        const cohort = results.cohort || {};
        return {
          totalPosts: rows.length,
          aiRelated: aiRows.length,
          stances: dist.stances || {},
          experience: dist.experience || {},
          topicTotals: topNObj(dist.topicTotals, 20),
          cohort: {
            negPostShare: cohort.negPostShare,
            negAuthorShare: cohort.negAuthorShare,
            negEngagementShare: cohort.negEngagementShare,
            basisCounts: cohort.basisCounts
          },
          spikes: (results.signals && results.signals.spikes) || []
        };
      }
    }
  ];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function runRollup({ store, aoai, context, env = process.env, now = () => new Date(), fetchImpl = globalThis.fetch }) {
  const startedMs = Date.now();
  const rawRows = await store.listAnalyzedPosts();
  const { items: parsed, skipped: rowsSkipped } = parseRows(rawRows);

  // Bot / boilerplate exclusion (§3c). Rows carry `contentClass` once
  // POST /api/retag has run. Until then — and for anything ingested since the
  // last retag — the rollup classifies on the fly from what it has: author,
  // distinguished, stickied, and title repeat-hash within each sub. Bodies are
  // not in the posts table, so this is a subset of retag's power, but it means
  // an un-retagged corpus is never silently counted as writer sentiment.
  const rows = classifyUntagged(parsed, env);
  const humanRows = rows.filter(contentClass.isHuman);
  const nonHumanRows = rows.filter((r) => !contentClass.isHuman(r));
  const aiRows = rows.filter((r) => r.aiRelated);
  const humanAiRows = humanRows.filter((r) => r.aiRelated);
  const weeks = [...new Set(humanRows.map((r) => r.week).filter(Boolean))].sort();
  context?.log?.(
    `rollup over ${rows.length} analyzed rows: ${humanRows.length} human ` +
    `(${humanAiRows.length} AI-related), ${nonHumanRows.length} bot/boilerplate excluded, ${rowsSkipped} unparseable`
  );

  // Comment corpus: triage columns only — no bodies, no blobs, no model calls.
  // Feeds discovery (ingest-time r/Sub extraction) and the policy dry run that
  // prices comment analysis before any of it is switched on (§3b).
  let commentMentions = [];
  let commentStats = null;
  if (typeof store.listCommentTriage === 'function') {
    try {
      const triage = await store.listCommentTriage();
      commentMentions = triage.map((c) => ({
        subreddit: c.partitionKey,
        mentions: c.subMentionsCsv ? String(c.subMentionsCsv).split(',').filter(Boolean) : []
      }));
      const aiFlags = typeof store.analyzedPostAiFlags === 'function'
        ? await store.analyzedPostAiFlags()
        : new Map();
      const dry = commentPolicy.dryRun(triage, aiFlags, { minChars: config.commentMinChars(env) });
      const submissions = rows.filter((r) => r.kind === 'post').length;
      commentStats = {
        ...dry,
        analyzed: triage.filter((c) => c.analyzed === true).length,
        policy: config.commentAnalyzePolicy(env),
        commentsPerSubmission: submissions ? triage.length / submissions : null,
        submissionsAnalyzed: submissions
      };
    } catch (e) {
      context?.warn?.(`comment corpus scan failed (non-fatal): ${e.message}`);
      commentStats = { error: e.message };
    }
  }

  const sections = buildSections({
    rows, aiRows, humanRows, humanAiRows, nonHumanRows,
    weeks, env, aoai, store, context, now, commentMentions, commentStats
  });
  const { results, written, failed, rowIssues } = await runSections(sections, {
    saveAggregate: (p, k, v) => store.saveAggregate(p, k, v),
    context,
    now
  });

  const summary = {
    ok: failed.length === 0,
    sectionsWritten: written,
    sectionsFailed: failed,
    rowsScanned: rawRows.length,
    rowsAnalyzed: rows.length,
    rowsSkipped,
    // Corpus/pricing figures for the comment round. `commentCorpus.wouldSelect`
    // is a COUNTED dry run of the live policy predicate, not an estimate —
    // §10.3 requires it before any further comment walk is queued.
    commentCorpus: commentStats,
    rowIssues,
    durationMs: Date.now() - startedMs,
    finishedAt: now().toISOString()
  };

  // Health row — makes the last run's outcome readable from /api/insights even
  // when the caller never saw the HTTP response (timer runs, gateway cuts).
  try {
    await store.saveAggregate('rollup-health', 'latest', summary);
  } catch (e) {
    context?.error?.(`could not persist rollup health: ${e.message}`);
  }

  // Publish title-level boilerplate hashes to the registry so the analyze path
  // can apply repeat-hash at point-of-analysis (§3a). The rollup only sees
  // titles — bodies live in the raw archive and are retag's job — so this
  // MERGES rather than replaces.
  try {
    const titleIndex = contentClass.buildRepeatIndex(
      rows.map((r) => ({ subreddit: r.subreddit, title: r.title, body: '' })),
      { minChars: config.boilerplateMinCharsBody(env), minTitleChars: config.boilerplateMinCharsTitle(env) }
    );
    summary.boilerplateRegistry = await boilerplateRegistry.merge(
      store,
      boilerplateRegistry.fromRepeatIndex(titleIndex, { minRepeats: config.boilerplateMinRepeats(env) }),
      { now, context }
    );
  } catch (e) {
    context?.warn?.(`boilerplate registry update failed (non-fatal): ${e.message}`);
  }

  // Brain hook: file a digest trace when momentum signals fire.
  const spikes = (results.signals && results.signals.spikes) || [];
  if (env.BRAIN_CAPTURE_URL && spikes.length > 0) {
    try {
      const cohort = results.cohort || {};
      const digest = `Listening Post signals ${results.signals.week}: ${spikes.map((s) => `${s.label} ×${s.ratio} (${s.thisWeek} posts vs ${s.trailingMean} avg)`).join('; ')}. Cohort: neg OP share ${((cohort.negPostShare || 0) * 100).toFixed(0)}%, neg author share ${((cohort.negAuthorShare || 0) * 100).toFixed(0)}%. Corpus ${rows.length} posts (${aiRows.length} AI-related). Dashboard: scribsy-insights SWA.`;
      await fetchImpl(env.BRAIN_CAPTURE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'text', content: digest, notes: 'Auto-filed by Listening Post rollup (topic spike detected)', domain: 'kb/scribsy' })
      });
      context?.log?.('brain capture posted');
    } catch (e) {
      context?.warn?.(`brain capture failed (non-fatal): ${e.message}`);
    }
  }

  context?.log?.(`rollup done: ${written.length} written, ${failed.length} failed, ${summary.durationMs}ms`);
  return summary;
}

module.exports = {
  parseRows, forEachRow, runSections, buildSections, runRollup, computeCohort,
  topNObj, count, buildRecurrenceIndex, salienceOf, bySalience, classifyUntagged
};
