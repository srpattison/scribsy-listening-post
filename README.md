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
| Fast / skewed | **Bluesky** open AppView API (real-time query streams) | Momentum signals, PR radar, flashpoints | Literary/professional, skews anti-AI |

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
`scribsylisten2026`, functions `scribsy-listen-fn-2026` (Node 24, consumption),
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

Idempotent — safe to re-run; re-running also redeploys code (new zip → new
`WEBSITE_RUN_FROM_PACKAGE`).

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
