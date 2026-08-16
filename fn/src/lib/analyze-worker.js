'use strict';

// Queue-message processing for the `analyze` trigger, extracted from
// functions/analyze.js so it is testable the same way every other pass in
// this codebase is (lib/*.js holds the logic; functions/*.js just wires a
// trigger to it — see lib/retag.js / functions/retag.js).
//
// Daily spend guardrail: DAILY_ANALYZE_CAP. Comment spend guardrail:
// COMMENT_ANALYZE_POLICY, which ships as `ingest-only` so comments are archived
// but never analyzed until the policy is explicitly widened (§3b).
//
// The daily cap, the filter tally and the comment-gate tally are all reserved
// via optimistic-concurrency (ETag) compare-and-swap, not a blind read-modify-
// write — up to 16 concurrent queue handlers hit these counters at once, and a
// blind write lets N handlers collapse into ~one effective increment
// (CB-LISTEN-REPO-7 §8n). See lib/daily-cap.js and lib/cas.js.

const store = require('./store');
const config = require('./config');
const commentPolicy = require('./comment-policy');
const { analyzePost, embedTexts, vecToB64 } = require('./aoai');
const { filterComments } = require('./comment-filter');
const registry = require('./boilerplate-registry');
const dailyCap = require('./daily-cap');
const { SCHEMA_VERSION, mentionsAi } = require('./taxonomy');

// Registry lookups are cached across queue messages: the registry is small,
// changes only when retag or the daily rollup writes it, and the analyze queue
// calls this once per message.
const defaultRegistryCache = registry.createCache(store);

const todayKey = () => new Date().toISOString().slice(0, 10);

// Atomically claim the next daily-cap ticket BEFORE any model call, and only
// then decide whether that ticket is within cap (§8n requirement 1 — "reserve
// before spending"). On analysis failure below, the reservation is left to
// stand rather than released: analyzePost() can fail AFTER the AOAI round
// trip has already happened (e.g. a malformed-JSON response), so a failed call
// may still represent real spend. Releasing on failure risks under-counting
// that spend, and never-under-counting is the harder constraint the brief sets
// for this counter — a small over-count from genuine failures is the safe
// direction. On CAS retry exhaustion, fail closed: never spend against a
// counter that could not be safely updated.
async function reserveDailySlot(storeImpl, context) {
  const { cap, configError } = config.dailyAnalyzeCap();
  if (configError) context.error(configError);
  const today = todayKey();
  const backend = storeImpl.aggregateBackend('analyze-counter', today);
  try {
    const { ok, count } = await dailyCap.reserveDailySlot(backend, cap, { context });
    return { ok, count, today, cap, configError, reserved: true };
  } catch (e) {
    context.error(`analyze-counter reservation failed for ${today}: ${e.message}`);
    return { ok: false, count: null, today, cap, configError, reserved: false, error: e };
  }
}

// Process one queue message. `deps` allows tests to inject a fake store, a
// spied/faked AOAI chat client, and a registry cache bound to that fake store,
// without mocking Azure SDKs.
async function processAnalyzeJob(job, context, { storeImpl = store, chat, registryCache = defaultRegistryCache } = {}) {
  const { subreddit, id, created_utc } = job;
  const kind = job.kind === 'comment' ? 'comment' : 'post';

  let raw;
  try {
    raw = await storeImpl.getRaw(subreddit, created_utc, id, kind);
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
        const parent = await storeImpl.getPostRow(subreddit, linkId);
        parentAiRelated = !!(parent && parent.aiRelated);
      } catch { /* unknown parent → predicate falls back to the body test */ }
    }
    const decision = commentPolicy.shouldAnalyze(
      { body, bodyChars: body.length, aiPrefilterHit: mentionsAi(body) },
      { policy, parentAiRelated, minChars }
    );
    if (!decision.selected) {
      await dailyCap.bumpCommentCounter(storeImpl.aggregateBackend('comment-gate', todayKey()), 'skipped', { context })
        .catch((e) => context.warn(`comment-gate counter failed: ${e.message}`));
      context.log(`comment ${subreddit}/${id} not analyzed (policy=${policy}, reason=${decision.reason})`);
      return; // archived in `raw`, re-analyzable later via /api/reanalyze
    }
  }

  const reservation = await reserveDailySlot(storeImpl, context);
  if (!reservation.ok) {
    const why = reservation.reserved
      ? `cap reached (cap=${reservation.cap}, reserved slot=${reservation.count})`
      : 'reservation failed after CAS retries';
    context.warn(`analyze cap: ${why} — deferring ${subreddit}/${id} 6h`);
    await storeImpl.enqueueAnalysis(job, 6 * 3600);
    return;
  }

  // Prompt-side bot/boilerplate filtering (§3b). Bot text must not enter the
  // prompt: once it does, it lands in this row's verbatim quote fields and
  // comment_stance_mix, and no amount of row-level tagging can remove it —
  // this row is genuinely human-authored.
  //
  // The raw blob is NOT modified; only what reaches the model is narrowed.
  const boilerplateHashes = await registryCache.get(subreddit).catch(() => new Set());
  const { kept: promptComments, reasons: filterReasons, filteredCount } =
    filterComments(raw.comments || [], {
      registry: boilerplateHashes,
      minChars: config.boilerplateMinCharsBody()
    });
  if (filteredCount) {
    context.log(`filtered ${filteredCount} bot/boilerplate comment(s) from ${subreddit}/${id}: ${JSON.stringify(filterReasons)}`);
    await dailyCap.recordFiltered(storeImpl.aggregateBackend('filter-counter', todayKey()), filterReasons, { context })
      .catch((e) => context.warn(`filter counter failed: ${e.message}`));
  }

  const analysis = await analyzePost(raw.post, promptComments, chat ? { chat } : undefined);

  // Subreddit-mention extraction (regex, zero LLM cost) — feeds the discovery
  // view. Comments have this extracted at ingest, because their analysis is
  // gated and may never run. Filtered comments are excluded here too: a bot
  // reciting "see r/writing in the sidebar" is not a community citation.
  const mentionText = [raw.post.title, raw.post.selftext, ...promptComments.map((c) => c.body)].join('\n');
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

  await storeImpl.saveAnalysis(subreddit, id, analysis, {
    embB64,
    schemaVersion: SCHEMA_VERSION,
    subMentionsCsv: [...mentions].slice(0, 30).join(','),
    kind,
    // Per-row provenance for the filter: how many comments were withheld from
    // this row's prompt, and which detector fired (§3c).
    botCommentsFiltered: filteredCount,
    botCommentsFilterReasons: filterReasons
  });
  if (kind === 'comment') {
    await dailyCap.bumpCommentCounter(storeImpl.aggregateBackend('comment-gate', todayKey()), 'analyzed', { context })
      .catch((e) => context.warn(`comment-gate counter failed: ${e.message}`));
  }
  context.log(`analyzed ${kind} ${subreddit}/${id} v${SCHEMA_VERSION} ai=${analysis.ai_related} stance=${analysis.stance_on_ai}`);
}

module.exports = { processAnalyzeJob, reserveDailySlot };
