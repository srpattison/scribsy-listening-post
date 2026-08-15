'use strict';

// Configuration access — LOUD BY DESIGN.
//
// Ruling from CB-LISTEN-REPO-4 §9.1: no setting may fall back to a stale copy
// of live configuration. `taxonomy.js` used to carry a DEFAULT_SUBREDDITS list
// that had drifted to 10 entries against a live list of 23; had SUBREDDITS ever
// been unset, the app would have quietly ingested the wrong 10 subs and every
// aggregate built on top would have been confidently wrong.
//
// So: a setting that describes WHAT WE STUDY (which subs, which streams, which
// subs are enclaves) has no default at all — its absence throws a named error.
// A setting that is a mechanical knob may have a defensible constant, but never
// a copy of a live value.
//
// deploy.sh carries the shipped defaults and (per §10.4) preserves whatever is
// already live rather than overwriting it.

class ConfigError extends Error {
  constructor(setting, detail) {
    super(`required app setting ${setting} is not configured${detail ? ` — ${detail}` : ''}`);
    this.name = 'ConfigError';
    this.setting = setting;
  }
}

// --- Corpus definition: no defaults, ever -----------------------------------

function subreddits(env = process.env) {
  const raw = (env.SUBREDDITS || '').trim();
  if (!raw) throw new ConfigError('SUBREDDITS', 'refusing to ingest with an unknown subreddit list');
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new ConfigError('SUBREDDITS', 'value is present but contains no subreddit names');
  return list;
}

function subTags(env = process.env) {
  const raw = (env.SUB_TAGS || '').trim();
  if (!raw) {
    // An empty map is not a safe default: it would silently pool deliberately
    // skewed enclave subs into the population cohort.
    throw new ConfigError('SUB_TAGS', 'refusing to compute cohort frames without enclave tags');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError('SUB_TAGS', `value is not valid JSON (${e.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError('SUB_TAGS', 'value must be a JSON object mapping subreddit → tag');
  }
  return parsed;
}

// Bluesky streams: [{ name, query, kind }] where kind is "topic" | "community".
//
// `topic` streams are keyword searches ON the subject under study. `community`
// streams are unfiltered writer-population samples. They are DIFFERENT SAMPLING
// FRAMES and must never be pooled — a corpus selected on people talking about AI
// cannot measure what fraction of writers talk about AI.
const STREAM_KINDS = ['topic', 'community'];

function bskyStreams(env = process.env) {
  const raw = (env.BSKY_STREAMS || '').trim();
  if (!raw) throw new ConfigError('BSKY_STREAMS', 'refusing to ingest Bluesky with an unknown stream list');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError('BSKY_STREAMS', `value is not valid JSON (${e.message})`);
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new ConfigError('BSKY_STREAMS', 'value must be a non-empty JSON array');
  }
  return parsed.map((s, i) => {
    const name = s && s.name;
    const query = s && (s.query !== undefined ? s.query : s.q); // tolerate the pre-round-4 `q` key
    const kind = (s && s.kind) || 'topic';
    if (!name || !query) throw new ConfigError('BSKY_STREAMS', `entry ${i} needs both "name" and "query"`);
    if (!STREAM_KINDS.includes(kind)) {
      throw new ConfigError('BSKY_STREAMS', `entry ${i} ("${name}") has kind "${kind}"; expected one of ${STREAM_KINDS.join(', ')}`);
    }
    return { name, query, kind };
  });
}

// Map stream name → kind, for frame assignment in the rollup. Never throws:
// the rollup must still produce cohort frames if the setting is malformed, it
// just cannot claim a stream is a population sample without being told so.
function bskyStreamKinds(env = process.env) {
  try {
    return Object.fromEntries(bskyStreams(env).map((s) => [s.name, s.kind]));
  } catch {
    return {};
  }
}

// --- Mechanical knobs: defensible constants allowed -------------------------

// Comment analysis policy. Ships as `ingest-only` (§3b, amended): comments are
// fetched and archived, and ZERO comment analysis runs until this is explicitly
// changed. The comment:post ratio for these subs is unmeasured and plausible
// values span 10×–40×, which is too wide to commit against the budget.
const COMMENT_POLICIES = ['ingest-only', 'policy', 'all'];
const DEFAULT_COMMENT_POLICY = 'ingest-only';

function commentAnalyzePolicy(env = process.env) {
  const v = (env.COMMENT_ANALYZE_POLICY || DEFAULT_COMMENT_POLICY).trim();
  // An unrecognised value must not silently widen spend — fail closed.
  return COMMENT_POLICIES.includes(v) ? v : DEFAULT_COMMENT_POLICY;
}

function commentMinChars(env = process.env) {
  const n = parseInt(env.COMMENT_MIN_CHARS || '400', 10);
  return Number.isFinite(n) && n > 0 ? n : 400;
}

// Daily spend guardrail. There is no defensible constant for a budget ceiling —
// 1500 was a stale copy of a live value that had since become 12000 — so an
// unset cap analyses NOTHING and says so. Failing closed defers jobs (they are
// re-enqueued, not dropped) instead of spending against a guessed ceiling.
function dailyAnalyzeCap(env = process.env) {
  const raw = (env.DAILY_ANALYZE_CAP || '').trim();
  if (!raw) return { cap: 0, configError: 'DAILY_ANALYZE_CAP is not configured — analysis is halted rather than run against a guessed ceiling' };
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    return { cap: 0, configError: `DAILY_ANALYZE_CAP is not a valid count ("${raw}") — analysis halted` };
  }
  return { cap: n, configError: null };
}

module.exports = {
  ConfigError,
  subreddits,
  subTags,
  bskyStreams,
  bskyStreamKinds,
  commentAnalyzePolicy,
  commentMinChars,
  dailyAnalyzeCap,
  COMMENT_POLICIES,
  DEFAULT_COMMENT_POLICY,
  STREAM_KINDS
};
