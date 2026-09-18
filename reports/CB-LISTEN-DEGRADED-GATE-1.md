# CB-LISTEN-DEGRADED-GATE-1

## Result
Containment implemented on branch feat/CB-LISTEN-DEGRADED-GATE-1, based on main d0e30cba8b87f4a16990c28c81446ba18ca20cf3. Not yet deployed.

Brief: https://app.notion.com/p/3de103cbb30381cf9c45e6955b83bad9

## Behavior
The strategy brief now checks every source section and the registry-load outcome before constructing its model evidence pack. Missing, degraded, stale, truncated or unavailable evidence blocks synthesis. Actual source errors have a distinct source-error reason. The entire brief is withheld because custom standing questions share one pack and do not have trustworthy per-answer dependency metadata. Zero strategyBrief calls means alternate sampleQuotes cannot bypass feature containment.

The insights API checks current dependencies for both all and brief views, refuses pre-fix cached briefs without an evidence-gate receipt, and removes degraded feature counts/examples from normal responses. Diagnostics remain stored. These reads use no-store. The dashboard clears prior rendered claims and displays an explicit unavailable/degraded message; unrelated healthy sections still render. A healthy generation carries a versioned gate receipt; registry and brief gate outcomes remain visible in rollup health.

## Verification (2026-09-17, Node on Windows with Git Bash)
- Unchanged main, isolated worktree, same installed dependencies: 226 tests, 224 pass, 2 fail.
- Changed tree: 234 tests, 232 pass, the same 2 fail. Zero new failures.
- Eight new containment tests pass, exercising real runRollup, registered insights handler with external dependencies stubbed, and actual dashboard availability/render functions.
- New tests against original runtime/API/UI: 7 fail, 1 passes (the new pure helper alone). In particular, the original normalization-failure path makes a strategyBrief call, original cached answers remain publishable, and original dashboard invokes the rendering callback. This establishes negative controls rather than only testing the helper in isolation.
- Updated the existing AOAI-outage expectation: brief is now blocked with empty answers rather than merely stale. Unrelated section-isolation behavior retained.
- node --check on changed runtime modules and git diff --check pass.
- No model calls, backlog enqueue, flag changes or production data writes performed by tests.

### Existing baseline failures
1. config.test.js: historical reports/CB-LISTEN-BOARDS-2.md duplicates the subreddit-list text, tripping the exactly-one-list assertion.
2. daily-cap.test.js: 200 simultaneous CAS increments exhaust retries with etag mismatch on this Windows runtime.
Both reproduced before this change; neither path changed. Initial environment-only missing-dependency/Bash failures were resolved before the comparable baseline and final runs.

## Limits and deployment
This is containment, not corpus validation or quote-level repair. It does not certify healthy-looking feature rankings or fix recurrence coverage, attribution, first-400 selection, or backlog enqueue. Those remain separate work.

Production rollout requires publishing both fn and swa from the reviewed commit while preserving live Azure settings. This machine has no Azure CLI login; Chrome Cloud Shell currently requires sign-in. No production merge or deployment is claimed. Verify /api/ping deployedSha plus authenticated insights all/brief/features after publication. Legacy briefs must immediately be unavailable until a successfully gated rollup runs. Do not enqueue backlog or trigger reanalysis for this verification.

## Feature recovery follow-up (2026-09-17)

The preceding containment round shipped in PR #6, merge 467449a, with live API/UI withholding verified. Steven then authorized diagnosis, correction and one controlled manual rollup. Recovery brief: https://app.notion.com/p/3de103cbb30381ee877cf43d1f562c18.

Live feature-only replays used the existing first-400 input (386 distinct names, 14,793 prompt characters, 48,836 total feature rows). No aggregates were written by these probes.

- Baseline gpt-5-mini-2025-08-07: HTTP 200, finish=length, 6,000 completion tokens, all 6,000 reasoning, zero content. This establishes token exhaustion rather than refusal.
- Lower effort with the same 6,000 cap: finish=stop, 1,727 completion / 896 reasoning, but all 400 names collapsed into one group. Rejected on semantic quality; not shipped.
- Normal effort with a 16,000 cap: finish=stop, 9,852 completion / 4,416 reasoning, 399 singleton groups and one omitted input. Rejected on coverage; not shipped as-is.

The candidate keeps normal reasoning and a feature-only 16,000 cap, deterministically combines exact names, and requests only near-equivalent merges. Unmentioned inputs deliberately retain their own names and original row indexes. It validates disjoint in-range merge membership. An incomplete/refused/empty model response still throws and activates containment; no silent fallback or retry is added. Oversized prompts fail explicitly rather than clipping away inputs. Errors expose only allowlisted finish reasons and numeric usage counts.

Nine REST-boundary tests cover failure diagnostics, parseable-but-incomplete replies, refusal, successful output, invalid membership, oversized input, and exact preservation under sparse merges. Full local suite: 241/243, same config-list and CAS baseline failures as the containment round. Actual sparse-merge replay and live regeneration are pending at this candidate commit; final operational receipts belong in the linked brief. No token/model settings for post analysis or other synthesis calls changed. The first-400 selection and broader quote-quality repair remain separate limitations, not certified by this change.

## Corpus-quality benchmark preparation (2026-09-17 ET)

Steven approved baseline -> contribution filtering -> representative feature coverage -> targeted reanalysis validation. Brief: https://app.notion.com/p/3df103cbb30381f49aa1ef576e0d4302 . This slice adds a read-only benchmark runner; it does not change production aggregation or claim corpus acceptance.

The sampler records a fixed seed and selection hash, balances observed source/community, kind, month and prompt-version strata, and explicitly reports uncovered strata. It selects a 120-row diagnostic panel and a 1000-row pilot manifest. An independent challenge panel selects recurrent feature/notable quotes; recurrence is a review candidate, not a boilerplate verdict. Source matching distinguishes own text, contextual comments, filtered sources, multiple origins, short ambiguous strings, unavailable blobs and unmatched text. Semantic judgments remain unreviewed.

The runner refuses output within the repository, uses a fresh private output directory, performs no model calls or production writes, and keeps source rows/blobs and review data private. Only the aggregate summary is publishable. Six new tests pass, including shuffled-input invariance and positive/negative attribution controls. Combined relevant suite:61/61. Live source benchmark is pending Azure Cloud Shell access; do not infer a contamination rate from these tests.

### Live baseline measured (2026-09-18 UTC)
The read-only runner completed against103,493 analyzed rows. The diagnostic panel covered120 of352 observed strata; all120 source blobs were readable and registry reads succeeded. Of218 extracted quote fields:204 had one unfiltered source match,1 matched only a filtered source,4 were short/ambiguous, and9 did not match under the stated normalization. These are origin checks, not semantic ground truth or population estimates. The separately enriched20-record recurrence challenge produced153 quotes:80 single-origin,22 filtered-source-only,51 unmatched. Source inspection confirmed AutoModerator instructions being extracted as feature requests/notable quotes, including search, manuscript-swap and spam-filter guidance.

Selection hash:e372b521b6ecaaee01d8ababff42620648f7b390f867d59675beec5545b2d7b3. A1,000-row pilot manifest is selected; no reanalysis was performed. No model calls or production aggregate writes occurred. Private source records are excluded from Git and archived separately in existing private Azure audit storage. Candidate filtering and semantic review remain pending; this commit is the measurable baseline, not a production quality fix.

## Contribution source filter candidate (2026-09-18)

Adds a production preflight that checks quote-bearing contributions against raw sources before aggregation. Removes an item only when every matching source is explicitly bot-authored, moderator-distinguished or stickied; registry hashes and recurrence alone do not justify the new exclusion. Counts, examples, notable quotes and downstream quote inputs change together. Raw archives and stored analysis are unchanged. Missing sources abort before aggregate writes.

Six new controls pass, including retained repeated human opinions and human/bot ambiguity, atomic board changes, and missing-source failure. Focused suite: 22/22. Full Windows candidate 250/257 versus predecessor bbde21b 244/251: identical seven failures (five bash-unavailable deployment tests, one CAS timing control, one existing duplicate-list test), zero new failures. Live frozen replay and read-latency acceptance remain pending; this commit is a candidate, not deployed.

## Frozen-source replay and feature coverage candidate (2026-09-18)

Replay preserved panel hash e372b521b6ecaaee01d8ababff42620648f7b390f867d59675beec5545b2d7b3. Diagnostic panel: 120 rows, 218 -> 217 quote fields, one confirmed feature contribution excluded. Union of diagnostic/challenge records: 138 rows, 353 -> 337 fields; exclusions comprise eight features, four notable quotes and four trust signals. Zero remaining explicitly bot/moderator-attributed eligible quotes and zero unexpected removals against archived origin checks. Registry-only and ambiguous cases remain for semantic adjudication; this is not an independent semantic gold set or prevalence estimate. No model calls or production aggregate writes.

Feature selection now uses seeded source/community/post-comment/month coverage at the unchanged 400-entry cap. It reports selected/population counts, strata counts and selection hash, and keeps ordinary non-AI features eligible. Publication strips private sampling identifiers. The strategy evidence scope and mandatory caveat describe a balanced diagnostic sample, not population-weighted prevalence. Storage-order reversal and later-source/time controls pass. Full local suite: 252/259; same seven predecessor failures, zero new failures. Full-read runtime validation, bounded model comparison and deployment remain pending.

## Editorial gate and pilot recovery hardening

The first private candidate brief passed the machine gate but was rejected editorially: it equated hostile/wary coding with total rejection of all AI, called the primary online frame representative, and returned high confidence. None was published. The revised evidence pack explicitly names unreviewed semantic validity and a low-confidence ceiling; code enforces that ceiling even if the model emits high. The prompt distinguishes negative-stance proxies from total rejection and prohibits population-representativeness claims. A positive/negative confidence control passes.

Pilot setup initially stopped before model calls because archive serialization order differed from manifest order, despite exact membership. Manifest order is restored with integrity checks. The runner now supports explicit checkpoint resumption without retrying completed records, preserves a pre-resume copy, and stops after five consecutive row errors rather than five sparse exceptions across 1,000 records. Model calls remain daily-cap reserved; no analysis is written back.

## Same-input aggregation and presentation verification

The full frozen-input replay has no failed sections before or after. Eligible-human feature mentions fall from 48,836 to 48,340 (496 exclusions after existing row-level filtering). The 400 selected mentions cover all 291 observed source/community/post-comment/month strata; selection hash d885833215e3eee4937528c1f6cbd670cdbaa8f10ee3e154b2a705450fbc0142. The broader preflight total of 701 feature exclusions includes rows already excluded by the existing row classifier and must not be presented as the board delta.

A real private model preview completed all sections and generated five answers, but editorial review blocked publication until modeled persona claims were separated from observed cohort evidence. Strategy inputs now omit model persona shares/goals/quotes and quote illustrations while semantic review is incomplete. The dashboard labels observed-frame negative coding accurately, reports feature selection coverage, and no longer calls model persona shares a measured percentage of voices. These are quality/interpretation changes, not a claim that semantic corpus validation is complete.
