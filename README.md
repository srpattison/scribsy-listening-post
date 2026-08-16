# Scribsy Listening Post

Writer-sentiment listening pipeline: two-frame ingestion → Azure OpenAI
analysis → exploratory insights dashboard (personas, topic heat map, stance
trends, feature requests, quote explorer) + research query layer. Runs entirely
on Azure Founders Hub credits — zero Claude usage, zero API keys, zero
approvals after deploy.

## Sources: the two-frame design

Reddit closed self-serve API access (Responsible Builder Policy, Nov 2025), so
ingestion runs on two open sources with deliberately different jobs:

| Frame | Source | Job | Bias to remember |
|---|---|---|---|
| Deep / lagged | **Arctic Shift** (free Reddit archive; lags live by days–weeks) | Strategy questions: deal-breakers, trust, personas, cohort | Hobbyist/aspiring, outspoken |
| Fast / skewed | **Bluesky** authenticated XRPC via the PDS (real-time query streams) | Momentum signals, PR radar, flashpoints | Literary/professional, skews anti-AI |

Bluesky requires an app password (`BSKY_IDENTIFIER` + `BSKY_APP_PASSWORD` at
deploy time): the unauthenticated AppView CDN (public.api.bsky.app) 403s
datacenter egress IPs (verified from both Azure and GCP, Aug 2026), while the
PDS (bsky.social) serves authenticated datacenter traffic normally. Use an app
password from Settings → App Passwords, never the account password.

**Frames are never pooled for population-level claims** — the rollup computes
the cohort per frame (Reddit = primary), and the strategy brief is instructed
to report per-frame and treat cross-frame divergence as a finding. The official
Reddit OAuth adapter stays dormant: if a registration at
developers.reddit.com/app-registration is ever approved, set
`REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` + `REDDIT_MODE=oauth` and live Reddit
ingestion switches over. Arctic Shift is volunteer-run with no SLA — if it
dies, everything already ingested is retained and only the supplier changes.

## Architecture

```
Arctic Shift (10 writing subs,     Bluesky AppView (query streams,
 watermark + 3-day overlap)          real-time, since-watermark)
   │  daily timer 10:10 UTC (+ resumable historical backfill)
   ▼
ingest fn ──► Blob raw/ (full post+comments JSON)
   │          Table posts (metadata)
   ▼
Queue analyze-jobs ──► analyze fn ──► Azure OpenAI `chat` deployment
   │                                   (structured JSON: stance, persona, topics,
   ▼                                    pain points, feature requests, quotes)
Table posts (analysis columns)
   │  daily rollup 13:00 UTC (+ manual)
   ▼
rollup fn ──► Table aggregates (heatmap, stance, distributions, features,
   │           quotes, AOAI-synthesized personas)
   ▼
insights API (function-key auth) ◄── Static Web App dashboard
```

Resources (RG `scribsy-listening`, eastus; SWA in eastus2): storage
`scribsylisten2026`, functions `scribsy-listen-fn-2026` (Node 22, Flex Consumption),
AOAI `scribsy-aoai-2026` (deployment `chat`), SWA `scribsy-insights`. App
Insights `scribsy-listen-fn-2026-ai` wired to the existing `scribsy-logs`
workspace. Secret copies land in `scribsy-kv-2026`.

## Deploy (Azure Cloud Shell)

1. Upload this folder to Cloud Shell home (or `unzip scribsy-listening-post.zip`).
2. `BACKFILL=1 bash scribsy-listening-post/deploy.sh` — no credentials needed.
3. Open the printed dashboard URL, paste the printed API base + key.
4. Arctic backfill is resumable: re-run the printed per-sub backfill calls
   until each responds `"exhausted": true` (each call walks ~7.5 min of archive
   from a saved watermark).
5. After the analysis queue drains (a day or two under the default 1500/day
   cap): `curl -X POST 'https://scribsy-listen-fn-2026.azurewebsites.net/api/rollupNow?code=<key>'`
   — thereafter the daily timers keep everything fresh.

Idempotent — safe to re-run; re-running also redeploys code (`func azure
functionapp publish`; Flex manages its own deployment container). Re-running
reasserts the `SUBREDDITS`/`SUB_TAGS` defaults unless overridden via env.

## Research layer

- **Strategic answers** — five standing questions (minimum bar/deal-breakers,
  trust builders/breakers, wishlist AI vs non-AI, post-AI personas + dominance,
  anti-AI loud-minority-vs-anxious-majority incl. philosophical-vs-doom basis)
  re-answered from the full corpus at every rollup, with confidence, caveats,
  and verbatim evidence. Override the questions with the `STANDING_QUESTIONS`
  app setting (JSON array of strings) — no redeploy.
- **`POST /api/ask`** `{ "question": "...", "filters?": { stance, topic,
  subreddit, aiOnly } }` — ad-hoc natural-language queries over the analyzed
  corpus (aggregates + score-ranked 300-post sample), answered with cited
  quotes. Also wired into the dashboard ("Ask the corpus").
- **`POST /api/export`** — full JSONL dump of every analyzed row (post meta +
  complete analysis JSON) to blob, returns a 24h SAS URL. Feed it to DuckDB,
  a notebook, or a Claude session for anything the API can't answer.
- Per-post analysis dimensions: stance + **stance_basis** (why negative:
  philosophical-authorship / economic-livelihood / craft-quality /
  consent-training-data / community-pressure / bad-experience / vague-doom),
  intensity 0–3, **comment_stance_mix** (top-comment stances — evidence for
  majority/minority questions), expected_baseline, deal_breakers (kind +
  quote), trust_signals (builds/breaks + quote), feature_requests
  (ai_related flag + quote).

## Bot and boilerplate exclusion

AutoModerator megathreads run on a schedule, so a 12-month backfill captures
dozens of byte-identical copies per sub, each carrying the subreddit's rule
text. A frequency-weighted aggregate reads that as writer sentiment — and
because the repetition is *systematic* rather than random, it biases the corpus
toward appearing anti-AI, corrupting exactly the questions this system exists to
answer.

Detection is deliberately **general**. Hardcoding one bot name catches one bot;
writing subs also carry critique-thread bots, removal notices, and submission
templates the subreddit injects into post bodies with no bot author at all. So
the primary signal is **repeat-hash**: identical normalised text recurring more
than `BOILERPLATE_MIN_REPEATS` (default 5) times within one subreddit. Author
(`AutoModerator`), `distinguished == "moderator"` and `stickied` are cheap
high-precision signals layered on top.

Two length floors keep ordinary writing out of it — repeat-hash only applies
above them:

| Field | Floor | Why |
|---|---|---|
| body | 120 chars | "good luck with your draft" normalises to 25; rule text runs to hundreds |
| title | 40 chars | writers don't independently produce the same 40+ char headline; scheduled threads do |

Rows are **tagged, never deleted** — `contentClass` is `human` \| `bot` \|
`boilerplate`, with `contentClassReason` naming the detector that fired. Every
stance, quote, persona, trust, minbar, features, resonance, signals, cohort,
distributions and competitors aggregate reads human rows only. `meta` reports
human and non-human counts separately, never one blended number. The excluded
text surfaces in its own `rules` frame: what a subreddit formally prohibits is
real evidence about community norms — it simply is not sentiment.

Clean an existing corpus with **zero model calls**:

```bash
curl -s -X POST "$API/api/retag?code=$KEY" | jq .
```

`?bodies=1` additionally hashes post bodies from the `raw` archive (opt-in: blob
reads are Flex wall-clock, the dominant cost of this system), `?dryRun=1`
reports without writing, and `?contamination=1` adds the read-only measurement
described below. Nothing on any of these paths enqueues analysis.

### Known limit: prompt contamination predates row-level tagging

Before comment ingestion existed, comments were passed to the model as prompt
context and were never stored on the parent row. So a genuinely human post can
still carry contamination *inside* its `analysisJson` — a verbatim quote lifted
from a moderator sticky, and a `comment_stance_mix` that counted bot replies as
community stances. Tagging cannot reach that; only re-analysis can.

`?contamination=1` measures the blast radius without spending anything:

- **narrow** — a stored quote field matches a bot/boilerplate comment
- **broad** — any bot/boilerplate comment was in the prompt at all

Broad is the criterion that matters for `comment_stance_mix`: once a bot comment
was in the prompt the mix is unreliable whether or not its text surfaced, so
narrow undercounts. Both are reported per partition. Remediation is a separate,
deliberate decision.

## What the corpus is — and what it is not

**Submissions and comments.** Reddit posts are announcements and questions;
comments are where writers reason, disagree, and reveal deal-breakers. Both are
ingested. Every row carries `kind` (`post` | `comment`); comments also carry
`linkId` and `parentId` so threads can be reconstructed. Rows written before
comment support read as `post` — no migration required.

Comment **ingest** and comment **analysis** are decoupled. Comments are archived
to blob unconditionally (the archive window is the perishable resource), but
analysis is gated by `COMMENT_ANALYZE_POLICY`, which ships as **`ingest-only`**:
zero comment analysis runs until it is explicitly widened. Comment volume runs
10–40× submissions, so the policy is set from a measurement, never a guess —
`POST /api/rollupNow` reports `commentCorpus.wouldSelect`, a counted dry run of
the policy predicate over ingested comments that issues no model calls.

Queue a comment walk explicitly; it is never started automatically:

```bash
curl -s -X POST "$API/api/backfill?sub=writing&months=12&kind=comments&code=$KEY"
```

**Engagement numbers are not signal.** Arctic Shift captures a near-creation
snapshot and never backfills, and its capture lag varies per row — 35% of sampled
rows sit at `score` 1, 32% at 0 comments. That is not a uniform freeze that would
be obviously useless; it is a partial freeze that *looks* like genuine variance,
with lag that plausibly correlates with subreddit size and archive era. So
nothing weights, ranks, sorts or thresholds on it. The columns are kept as
stored metadata and surfaced as `scoreAtCapture` / `numCommentsAtCapture`, and
any surface showing them labels them "at archive capture, not current."

Where ranking is genuinely needed it is **corpus-derived**: how often a row's
claims recur across *distinct threads*. A concern raised in twenty threads
outranks one raised in a single popular one.

**Sampling frames are never pooled.** Reddit general subs are the
population-representative primary. Enclave subs (`SUB_TAGS`) are deliberately
skewed. Bluesky streams (`BSKY_STREAMS`) carry a `kind`: `topic` streams are
keyword searches *on the subject under study* and cannot answer population
questions; `community` streams (`#WriterSky`, `#BookSky`, `#WritingCommunity`)
are the unfiltered writer baseline and are never keyword-gated at ingest.
Pooling a topic-selected stream with a population stream would manufacture the
exact answer the loud-minority question is asking for.

**Configuration fails loudly.** `SUBREDDITS`, `SUB_TAGS` and `BSKY_STREAMS` have
no in-code defaults. If one is unset the app raises a named error rather than
falling back — a stale copy of live config in code is how a system ends up
confidently ingesting the wrong corpus. The subreddit list exists in exactly one
place in this repo: `deploy.sh`.

## Failure isolation

The rollup builds fifteen insight sections. Each one owns its own `try/catch`:
a section that throws writes `{ error, failedAt }` into its own row and the run
continues to the next. No single section can prevent a later one from being
written, and no single malformed row can abort the section it appears in —
per-row parses are guarded and counted (`rowsSkipped`).

- **`POST /api/rollupNow`** always returns a JSON summary, never an empty body:
  `{ ok, sectionsWritten, sectionsFailed: [{name, error}], rowsScanned,
  rowsAnalyzed, rowsSkipped, durationMs }`. It answers `207` when some sections
  failed, so a partial run is distinguishable from a clean one.
- **`GET /api/insights?view=health`** reports `rowsAnalyzed`, `rowsUnanalyzed`,
  `analyzeQueueDepth`, `lastRollupAt` and `lastRollupSectionsFailed`. The
  storage CLI cannot read this account's queue depth, so the app reports its own
  drain rate.
- **The dashboard distinguishes "failed" from "empty."** A section whose row is
  absent or carries `error` renders an explicit *unavailable — rollup failed*
  state plus a banner counting the dead sections. A confidently-empty dashboard
  is the failure mode this design exists to prevent.

Aggregates are written through a size guard: Azure Table Storage caps a String
property at 64 KiB of UTF-16 (32,768 characters), so large payloads are split
across numbered chunk properties and reassembled on read. A payload too large
even for that is shrunk *deliberately* — largest field dropped first, recorded
in `_truncated` — rather than sliced into unparseable JSON.

Run the unit tests with `cd fn && npm test` (Node's built-in runner, no deps).

## Extensibility layer (v3)

- **Schema versioning + re-analysis**: every row is stamped with the
  SCHEMA_VERSION it was analyzed under. `POST /api/reanalyze` re-enqueues
  older rows from the raw archive (params: `minVersion`, `limit`, `force=1`,
  `sub`) through the normal queue/cap. Evolving the schema is now: bump
  version, redeploy, call reanalyze.
- **History**: every rollup writes a dated `snapshot` aggregate (stances,
  cohort, topic totals, spikes). `GET /api/insights?view=snapshots` returns
  the series — trend lines over the answers themselves (e.g. "is anti-AI
  sentiment softening approaching November?").
- **Momentum signals**: topics ≥2× their trailing 4-week mean (min 5 posts)
  surface on the dashboard and, when the optional `BRAIN_CAPTURE_URL` app
  setting points at a webhook you control, auto-POST a digest there (we pipe
  ours into an internal knowledge base). Unset by default.
- **Semantic /api/ask**: posts are embedded at analysis time
  (`text-embedding-3-small`, 256-dim, stored per-row). Ask embeds the
  question and retrieves by cosine similarity instead of score rank; falls
  back gracefully if embeddings are missing. NOTE: this is a third, isolated
  embedding system (listening-post only) — never conflate with product RAG
  (Gemini) or the Brain (Voyage).
- **Competitor watch**: tool mentions carry sentiment + a switching flag;
  aggregates surface per-tool negative share and verbatim switching moments.
- **Pillar resonance**: posts scored against Scribsy pillar signals
  (provenance, continuity, trust/local, safe-AI-experimentation) — a ranked
  validation/engagement queue. Keyword rules live in `taxonomy.js`
  (`PILLAR_SIGNALS`) and recompute at rollup, no re-analysis needed.
- **Scale ceiling**: rollup/ask scan the full posts table in memory — fine to
  ~50–100k rows. Beyond that, `POST /api/export` + DuckDB/ADX is the path;
  the JSONL includes embeddings and schema versions for exactly that reason.

## Knobs (app settings)

- `SUBREDDITS` — comma list, no `r/` (Arctic Shift frame) · `BLUESKY_STREAMS` — JSON [{name,q},…] query streams · `REDDIT_MODE` — arctic (default) | oauth | off
- `DAILY_ANALYZE_CAP` — posts analyzed per day (default 1500); over-cap jobs
  defer 6h, nothing is dropped
- `MIN_COMMENTS_FOR_FETCH` — skip comment fetch below this count (default 3)
- `CHAT_MODEL` / `CHAT_MODEL_VERSION` (deploy-time) — defaults to `gpt-5-mini`
  `2025-08-07` (verified available Aug 2026; gpt-4o-mini is retired). If create
  fails, `az cognitiveservices account list-models -n scribsy-aoai-2026 -g
  scribsy-listening -o table` and re-run

## Data ethics & why this is public

This repo is published so anyone — including the platforms whose public data
it reads — can verify exactly what it does: read-only ingestion, aggregate
analysis, no writes to any platform, no model training on platform data, no
tracking or profiling of individual users.

Commitments we hold ourselves to, and that any fork should too:

- **Raw post content is never republished or redistributed.** Dashboards and
  internal references link back to the original threads. Anything we may share
  publicly in the future is aggregate-level insight (topic trends, sentiment
  distributions), never a mirror of anyone's posts.
- **Read-only, low volume, identified.** No write endpoints of any kind; a
  clear User-Agent with a contact address; self-throttled far below platform
  rate limits.
- **LLM use is inference-only classification.** No AI/ML models are trained or
  fine-tuned on retrieved data.
- **People are not the unit of analysis; themes are.** No per-user tracking,
  scoring, or profiling.

## Notes

- Arctic Shift backfill walks the archive by created_utc with a saved watermark
  per sub — resumable across invocations; coverage of the most recent weeks may
  lag until the archive catches up (daily ingest's 3-day overlap absorbs this).
- All social data is used for internal market research only — don't republish
  post content; the dashboard links back to sources instead.
- Cost profile: consumption Functions ≈ free tier; AOAI is the meaningful burn
  (by design — it feeds the Founders Hub M5 consumption bar). Backfill ≈ 15–25k
  analyzed threads once, then ~100–300/day.
