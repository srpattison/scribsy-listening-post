# CB-LISTEN-FIX-1 — attribution and grounding repair

**Round:** CB-LISTEN-FIX-1 (repair step of containment → repair → validation)
**Branch:** `feat/CB-LISTEN-FIX-1`, cut from `main` at `0fee3bf029ae9773e2f29e2c72553d9d29191d51`
**Status:** draft PR. Not merged, not deployed. No model or API calls were made.

## Phase 0 — state reconciliation

- `main` HEAD: `0fee3bf029ae9773e2f29e2c72553d9d29191d51` ("Require editorial review before publishing strategic briefs (#11)").
- PR9, PR10 and PR11 are all **merged** (PR10 on 2026-09-18 04:17Z at head `f2ac0a2`; PR11 on 2026-09-18 23:15Z). `main` contains PR11 (`0fee3bf` is `main` itself).
- Stop-check: PR10's harness is already on `main`, so the branch is cut from `main`, not from PR10's head.
- The GitHub repo is a milestone mirror. Whether the deployed Azure package equals `main` **cannot be verified from Code**. Cowork checks it at deploy time.

## Diagnosis (Phase 1)

All references are to the baseline SHA `0fee3bf`.

### D1 — moderator/bot filter

- **Where:** `fn/src/lib/comment-filter.js:33-45` (`classifyComment`), applied to context comments at `fn/src/lib/analyze-worker.js:117-121`, before `analyzePost` at `analyze-worker.js:128`. The same classifier drives quote-origin checks (`quality-benchmark.js:61-82`) and rollup contribution exclusion (`contribution-filter.js:16-17`).
- **Keys:** literal author `automoderator` (`comment-filter.js:35`, set at `content-class.js:54`); `distinguished === 'moderator'` (`comment-filter.js:36`); `stickied === true` (`comment-filter.js:39`); whole-body registry hash (`comment-filter.js:40-43`). There is no text-pattern key.
- **`roleHint` is not computed anywhere in the repo.** It exists only in the review packets. Nothing in the analyze path derives a role from the author name.
- **Why `mod-team-account` / `automoderator` with `distinguished: null` pass:**
  1. Context comments are archived as `{ id, author, score, body }` only (`sources/arcticshift.js:128-134`, `reddit.js:100-105`). `distinguished` and `stickied` are captured for submissions (`arcticshift.js:48-49`) but **never for comments**, so those two detectors can never fire on a comment.
  2. A `<sub>-ModTeam` author matches no key.
  3. An AutoModerator *comment* is caught by the author key on `main`. An AutoModerator-authored *submission* is still sent to the model, because the analyze path never classifies the post unit (`analyze-worker.js:128`). The packet has 5 such submissions.
  4. The stored outputs in the packet are mostly unstamped legacy rows. In the pilot archive, 988 of 1,000 rows have no `analysisPromptVersion`, which means they were analysed before prompt-side filtering (REPO-6) existed. That explains AutoModerator *comment* text in stored outputs, which `main` would now filter.
- **Repetition-based suppression: yes, in two places.**
  - (a) `registry-hash` at `comment-filter.js:40-43`. The registry is admitted purely by repeat count (`boilerplate-registry.js:44-48`, `> minRepeats`; built by `retag.js:126,267`). So a ≥120-char normalised body recurring more than 5 times in a sub is excluded before the model on repetition alone.
  - (b) Rollup quote-recurrence exclusion (`boilerplate-filter.js:97`, `> minQuoteRepeats`; applied via `excludeItem`, `boilerplate-filter.js:134`).
  - Contribution filtering (`contribution-filter.js:16-17`) already refuses to exclude on `registry-hash` alone.
- **Contradiction check:** no material contradiction with the defect classes. The mod-team leak is live on `main`. The AutoModerator leak is live for submissions, and for any unit whose author is not literally `AutoModerator`. The comment case on `main` is closed. The stop condition does not apply, so the round proceeds.

### D2 — extraction prompt and schema

- **Minimum item counts:** none. No `minItems` appears in `ANALYSIS_SCHEMA` (`aoai.js:88-177`), and the prompt states no minimum.
- **Fields without a quote slot:** `pain_points` (`aoai.js:112`), `expected_baseline` (`aoai.js:113`), `ethics_concerns` (`aoai.js:153`) and `persona.goal` (`aoai.js:99`) are bare strings. `tools_mentioned` has `context` but no quote. **No field had a speaker slot.** Comments are labelled `[comment N]` (`aoai.js:222`), but outputs never referenced a label.
- **Product-lens framing:** yes. `aoai.js:179-180` frames the task "for a market-research tool" for a client building an editor, and asks for "what tooling they wish existed". `feature_requests` is defined as "concrete tooling capabilities people wish existed … normalize the feature name" (`aoai.js:191`). `expected_baseline` is defined as "table stakes any serious writing tool must have" (`aoai.js:188`).
- **Few-shot / example leakage:** inline examples "AI-usage disclosure log" (`aoai.js:191`), "trains on my manuscript" / "local-only storage" (`aoai.js:190`) and a tool list (`aoai.js:193`). No "inline commenting" or "support for large manuscripts" example exists in the repo.
- **Defaults:** the schema has none. The prompt primes experience with "(professional, hobbyist, aspiring)" (`aoai.js:180`). Downstream readers fall back to `'unknown'` (`rollup-engine.js:121`, `store.js:229`).

### D3 — validation

- Quote validation is substring existence only, after `NFKC` + lowercase + whitespace (`quality-benchmark.js:10`, `:74`). It searches **every** source (post plus all comments) and records which ones matched.
- Nothing checks a quote against an **attributed speaker's unit**, because there is no attribution.
- **Item text is never checked against its quote.** Only three quote-bearing list fields plus `notable_quote` are checked at all (`quality-benchmark.js:48-58`).

### D4 — stance

- `stance_on_ai` and `comment_stance_mix` are computed entirely by the model (`aoai.js:183`, `:186`). The rollup sums `comment_stance_mix` per row with no unit-level check (`rollup-engine.js:120`, `:260`).
- **Excluded units:** units filtered at `analyze-worker.js:117-121` never reach the prompt, so they cannot be counted. But mod-team and non-literal AutoModerator units are *not* excluded (D1), so they are counted. Nothing checks the mix total against the number of comments shown.
- **Literal AI mention:** not required by code for stance. The `mentionsAi` keyword prefilter (`taxonomy.js:56`) gates only whether a *comment row* is analysed (`analyze-worker.js:89`, `comment-policy.js:22`). The prompt asks for stance "on AI" per comment with no instruction to use thread context (`aoai.js:186`), which is consistent with the observed context-blind scoring.

## Changes (Phase 3)

| Fix | Change |
|---|---|
| **F1** | `comment-filter.js`: `roleHintOf()` derives `mod-team-account` (author `…-ModTeam`) and `automoderator`, and honours an explicit `roleHint`. Excludes `roleHint ∈ {mod-team-account, automoderator, moderator}`, `distinguished ∈ {moderator, admin}`, `MOD_BOT_AUTHORS`, and registered `BOILERPLATE_FINGERPRINTS` (normalised **sentence** hashes). A template plus a genuine sentence keeps the unit with only the template removed. `classifyPost()` stops an excluded-role submission before the daily cap and before the model. Per-row counts: `botCommentsFilterReasons` gains the new reasons and `boilerplate-fingerprint-partial`. `contribution-filter.js` accepts the new role reasons (still never `registry-hash` alone). `config.js` adds the two lists (default empty). `analysis-provenance.filterVersion` folds them in. |
| **F2** | `aoai.js` schema: every list item carries `quote` + `speaker` (`pain_points`, `expected_baseline`, `ethics_concerns`, `deal_breakers`, `trust_signals`, `feature_requests`, `tools_mentioned`). `persona` gains `goal_quote` / `goal_speaker`, and `notable_quote_speaker` is added. `feature_requests` gains `basis`. `SCHEMA_VERSION` goes 3 → 4. The rollup (`rollup-engine.js` `itemLabels`) reads legacy string items and v4 object items alike, and skips malformed ones without dropping the row. |
| **F3** | `ANALYSIS_SYSTEM` rewritten; prompt version moves (derived hash). It removes the product-lens framing and experience priming. New rules: items must not assert more than the quote supports; no invented implementations; empty is acceptable; quoted, hypothetical and fictional speech is not the speaker's experience; stance comes from thread context, not keywords; rules and policy restatements are not a stance. It applies the founder's `feature_requests` definition with `basis` (existing usage qualifies; never sourced from mod or bot text). |
| **F4** | New `grounding-validator.js`. The quote must normalise-match (case, whitespace, Markdown links, emphasis and blockquote, backslash and HTML escapes, curly quotes) inside the unit its `speaker` names, among the units the model was shown. Items that fail are dropped and counted per field and reason. `comment_stance_mix` totals above the number of shown comments are zeroed and counted. The worker stores `analysisJson.grounding = { checked, drops, dropReasons }` and logs drops. |

**Decision flagged for review — `registry-hash` (D1a).** The brief says repetition alone must never exclude text. The registry is repetition-derived and still excludes at the prompt (unchanged). Demoting it would change two existing tests (`prompt-filter.test.js:115`, `registry-provenance.test.js:72`), which acceptance check 2 (zero delta) forbids. It is also a behavioural change to REPO-6 that this brief does not list under F1. **Left unchanged; needs a ruling.** The new fingerprint path is explicit registration only and never counts repeats. T4 shows that two identical genuine opinions are both kept.

## Tests (Phase 2) — `fn/test/listen-fix-1.test.js`

All fixture text is invented: no real usernames and no Reddit text. The analyze path runs end to end through `processAnalyzeJob` with a spied chat client, so the test asserts **what the model was shown**, and the fake model's output then goes through the real validator.

| Test | Baseline `0fee3bf` | HEAD |
|---|---|---|
| T1 mod-team (by author, and by roleHint) excluded pre-model; never a source | ✖ `classifyComment` reason null | ✔ |
| T2 automoderator unit excluded (author / roleHint) | ✖ item quoting the welcome survives | ✔ |
| T2 AutoModerator submission not sent to model | ✖ model called | ✔ |
| T3 registered template excluded; template + genuine sentence → template removed only | ✖ no fingerprint API | ✔ |
| T4 negative control: two identical genuine opinions both kept | ✖ no grounding record | ✔ |
| T5 schema: every list item requires quote + speaker; persona goal quote | ✖ | ✔ |
| T5 normalise-match in attributed unit; wrong unit / missing unit / bad speaker rejected | ✖ validator absent | ✔ |
| T5 quote only in an excluded unit rejected whatever speaker it names | ✖ | ✔ |
| T6 excluded units never shown; overcounted mix rejected | ✖ 4 comments shown, expected 3 | ✔ |
| T7 empty lists validate; no `minItems` anywhere | ✖ validator absent | ✔ |
| T8 `feature_requests.basis ∈ {explicit_request, existing_usage, implied_need}` | ✖ no `basis` in schema | ✔ |
| Legacy: rollup reads string and object items; malformed skipped, row kept | ✖ object items passed through as objects | ✔ |

**Baseline run** (new test file copied into a worktree at `0fee3bf`): 0 pass, 12 fail. T1, T2, T5 (excluded-unit) and T6 fail on behaviour. The rest fail on the missing schema or API.

**T4 honesty note:** T4 is a negative control. Its behavioural claim (both opinions kept) also holds on baseline. On baseline it fails only because the grounding record it asserts does not exist there.

### Representative passing trial (HEAD, synthetic input)

Input: four comments.
1. An ordinary account's outline note.
2. `examplewriters-ModTeam` with `distinguished: null`: "Your submission has been removed because generated drafts are not permitted…"
3. An ordinary account posting a registered three-sentence critique-circle template.
4. An ordinary account posting that template plus "Honestly the pacing in chapter two dragged for me."

```
kept:     fixture_a → "I keep my outline in a spreadsheet so I can see every subplot at once."
          fixture_c → "Honestly the pacing in chapter two dragged for me."   (template removed)
filtered: examplewriters-ModTeam → role-mod-team-account
          fixture_b              → boilerplate-fingerprint
strippedCount: 1
validator on model output [ "generated drafts banned" (quote from the mod note, speaker comment 1),
                            "slow pacing in chapter two" (speaker comment 2) ]:
  retained: ["slow pacing in chapter two"]; dropReasons: { "pain_points:quote-not-in-unit": 1 }
```

## Acceptance checks

1. **Baseline behaviour:** T1–T8 (+ legacy) 12/12 fail on `0fee3bf` and 12/12 pass on HEAD. Representative trial above.
2. **Existing suite, zero delta:**
   - Baseline `0fee3bf`: 263 tests, 261 pass, 2 fail.
   - HEAD: 275 tests (263 + 12 new), 273 pass, 2 fail.
   - The same two failures, both pre-existing:
     - (a) `config.test.js` "the repo contains exactly one subreddit list": `reports/CB-LISTEN-BOARDS-2.md` also carries the list.
     - (b) `daily-cap.test.js` "200 interleaved CAS increments": a Windows timing control that fails on every run on this host at both SHAs. It is recorded as a known Windows baseline failure in `reports/CB-LISTEN-DEGRADED-GATE-1.md`.
3. **Syntax:** `node --check` passes on every changed JS file.
4. **Zero model calls:** the full suite ran with every AOAI/OpenAI/Anthropic/Azure/Reddit/Bluesky env var unset, plus a preloaded trap on `fetch`, `http(s).request/get` and `net.connect`. The trap loaded in 32 processes and logged 0 network attempts.
5. **Secret guard:** no `.env*`, `local.settings.json`, `*.env`, publish profile or connection string is staged. A pattern scan of the staged diff (automation webhook host, SAS signature, storage account key, connection-string prefix) finds nothing. The first scan flagged this report's own sentence naming the webhook host; it was reworded.
6. **Public-data guard:** `fn/scripts/public-data-guard.js` ran on the staged diff (counts in the PR description). The first run failed on two false positives:
   - a 40-dash run, where the test file's section divider matches a Markdown rule in private text;
   - the platform bot name `AutoModerator`, already named throughout the public code.

   The guard now ignores windows with fewer than 10 alphanumerics and allowlists platform system accounts. The re-run passes. No `u/` references are staged. `lp-private/` and `*.private.json` are added to `.gitignore`.
7. **Paths:** filter (`comment-filter.js`, `contribution-filter.js`, `config.js`, `analysis-provenance.js`), schema/prompt (`aoai.js`, `taxonomy.js`), validator (`grounding-validator.js`), wiring (`analyze-worker.js`), rollup legacy tolerance (`rollup-engine.js`), tests, the two scripts, this report, `README.md`, `.gitignore`.

## Private-fixture counts on stored outputs, before the fix

Produced by `fn/scripts/private-fixture-check.js` against `$LP_PRIVATE_DIR`: counts only, zero model calls, output written only to `$LP_PRIVATE_DIR/out/`.

**Hashes:** the SHA-256 of `JSON.stringify(parsed)` matches the recorded value for all three files (starter `9568745f…f5e9`, packet `49bd7c9a…8b8b`, report `dfd568aa…f276`). The raw-file SHA-256 is identical in each case, so both recording methods agree.

Exclusion is by the HEAD classifier. Stored outputs are pre-v4 and carry no speaker, so "not in attributed unit" is measured as "not found in any kept unit". Arms are the packets' own masked labels.

| Corpus | Units | Excluded (HEAD) | Excluded (baseline rules) |
|---|---|---|---|
| starter (3 cases) | 36 | 5 | 0 |
| packet (262 cases, 9 null sources) | 1,269 | 75 | 0 |
| judged subset (37) | 209 | 10 | 0 |
| pilot archive raw records (138) | 502 | 36 | 20 |

(Packet speakers are masked, so the baseline author rule cannot fire on packet units. The pilot archive carries real authors and shows the gap directly.)

**Items sourced only from excluded units** (per field):

| Corpus / arm | deal_breakers | trust_signals | feature_requests | notable_quote |
|---|---|---|---|---|
| starter A | 2 | 5 | 3 | 0 |
| starter B | 5 | 4 | 1 | 1 |
| packet A | 45 | 70 | 27 | 22 |
| packet B | 34 | 43 | 8 | 14 |
| judged A | 6 | 11 | 5 | 1 |
| judged B | 9 | 9 | 1 | 2 |
| pilot stored | 27 | 49 | 23 | 12 |

**Items whose quote is not found in any kept unit** (per field; includes the row above):

| Corpus / arm | deal_breakers | trust_signals | feature_requests | notable_quote |
|---|---|---|---|---|
| starter A | 2 | 5 | 6 | 0 |
| starter B | 5 | 5 | 1 | 1 |
| packet A | 48 | 93 | 56 | 33 |
| packet B | 37 | 61 | 25 | 24 |
| judged A | 7 | 14 | 11 | 3 |
| judged B | 9 | 12 | 2 | 3 |
| pilot stored | 30 | 56 | 33 | 13 |

**Ungroundable items (no quote slot pre-v4):**
- packet A: pain 842, baseline 542, ethics 324, persona.goal 244
- packet B: 794 / 479 / 286 / 235
- pilot stored: 364 / 240 / 142 / 135

**`comment_stance_mix` totals above the number of kept comments:** packet A 5, packet B 3, pilot 3, starter 0.

## What is NOT done

- No replay or reanalysis. The counts above are on **stored** outputs; the effect of F1–F4 on live model output is unmeasured.
- No deploy. Azure deploys by Cloud Shell run-from-package; this branch is not deployed. No merge.
- `registry-hash` repetition-based exclusion is unchanged, pending a ruling (see Changes). The rollup quote-recurrence exclusion (`boilerplate-filter.js:97`) is also unchanged.
- No boilerplate fingerprints are registered. `BOILERPLATE_FINGERPRINTS` ships empty, and registering real templates is an ops/config step. The new `MOD_BOT_AUTHORS` and `BOILERPLATE_FINGERPRINTS` settings are not added to `deploy.sh`, since both default to empty.
- Ingest still does not capture `distinguished` / `stickied` for comments. The author-name role signal now covers the observed cases, but capturing the flags is a separate ingest change.
- No semantic check of item-versus-quote meaning. The validator checks grounding only, so paraphrase drift *within* a correctly attributed unit is caught only by the prompt rules.
- No rubric edit, and the feature_requests ruling is not recorded as rubric v2.
- `scripts/quality-pilot.js` (the metered replay harness) does not yet pass the new exclusion lists or run the validator.

## Next actions

1. Cowork reviews the draft PR and marks every finding FOLDED or DECLINED (reason). This includes a ruling on `registry-hash`.
2. Steven merges. Cowork runs the Cloud Shell deploy, then verifies that `fn/src/lib/grounding-validator.js` exists at `ref=main` and in the deployed package.
3. After separate approval: one metered replay of about 40 fixed records (the 3 starter cases plus the 37 judged), within existing caps. Report paired before/after transitions by dimension. Re-run `private-fixture-check.js` on the replay outputs.
4. Record the founder's `feature_requests` ruling as rubric v2 via the Approvals path.

---

## Corrective round 1b (2026-09-25)

**Predecessor:** `ba3c7bf1a703f697c4357b8b83811395613a191a` on the same branch; no new branch was cut. **Scope:** Cowork review findings R1–R5, plus the repetition guard. R6 and R7 are deploy notes with no code change. The PR stays a draft: not merged, not deployed, no model calls.

### Findings

| Finding | Status | Change |
|---|---|---|
| **R1** Feature board pools `basis` | FOLDED | `rollup-engine.js` `features` section. Each mention carries `basis`; pre-v4 mentions are labelled `legacy`, never inferred. `existing_usage` is taken out of the ranked board and reported only as `existingUsage.count` and in `basisCounts`. The board holds `explicit_request`, `implied_need` and `legacy`. Each entry carries `byBasis`, and the brief `featureScope` carries `basisCounts` plus a note. |
| **R2** Replay path skips filter + validator | FOLDED | New `lib/analysis-pipeline.js` (`excludeUnits`, `groundOutput`) is used by **both** the analyze worker and `scripts/quality-pilot.js`. The pilot's per-row work is now an exported `replayRow`. An excluded submission is skipped before a cap slot is reserved, and the stored result carries `grounding`. `/api/reanalyze` already enqueues onto the analyze worker, so it was covered in round 1. |
| **R3** Validator checks full text, prompt is truncated | FOLDED | New `lib/prompt-view.js` holds the 6,000-char body cut and the 8,000-char comment-block cut. `analyzePost` builds its prompt from it (byte-identical output), and `grounding-validator` builds its units from the same view, so a quote from past a cut is rejected. |
| **R4** Audit tools miss v4 quote fields | FOLDED | `grounding-validator.quoteEntries` lists every quote location: notable quote, every list field, and `persona.goal`. `quality-benchmark.analysisQuotes`, `audit.quoteFieldsOf` and `retag.quotesFrom` now use it. `contribution-filter` also removes source-confirmed mod/bot items from the v4 fields and blanks a goal whose only source is excluded. |
| **R5** Ingest drops comment `distinguished` / `stickied` | FOLDED | Captured in `sources/arcticshift.js` (`fetchPostComments`) and `reddit.js` (`fetchTopComments`). |
| **R6** `SCHEMA_VERSION` 3→4 vs `/api/reanalyze` default | Deploy note, no code | Calling `/api/reanalyze` with its default `minVersion` would enqueue the whole corpus. Nothing in this round calls it. |
| **R7** Mixed v3/v4 rows on boards | Deploy note, no code | R1's `legacy` label and `basisCounts` make the feature-board mix visible. Other boards still mix v3 and v4 rows, so any comparison across the deploy date must say so. |

**Which sources carry comment role flags (R5):**
- **Arctic Shift:** yes. `/api/comments/search` returns Reddit's own comment fields, which is where comment *rows* already read them (`normalizeComment`).
- **Reddit OAuth:** yes. `t1` listing data includes both.
- **Bluesky:** no. Replies have no moderator-distinguished or stickied concept, so no role flag exists to capture.
- **Existing `raw` archives are not backfilled.** Comments already stored still lack the flags; only newly ingested comments carry them.

**registry-hash ruling:** recorded as the founder decision from the review (**DECLINED** removal). The guard below reports what it removes.

### Repetition guard (private fixtures, counts only)

These counts come from `fn/scripts/private-fixture-check.js` (`repetitionGuard`), with no model calls. Role is derived from the source unit: `ordinary` has no mod/bot role, `mod/bot` has one.

| Measure | Ordinary | Mod/bot | Other |
|---|---|---|---|
| `registry-hash` quote matches recorded against the **live** registry in the pilot archive's quote checks (138 records, all with the registry available) | 0 | 6 matches, 1 distinct unit | — |
| Units a registry **rebuilt from the pilot raw comments alone** would exclude (364 units; 2 hashes pass the production rule) | 0 | 20 | — |
| Same, **packet comments pooled across subs** (1,016 units; 3 hashes). Pooling can only over-count, so this is an upper bound for the slice | 0 | 43 | — |
| Rollup **quote-recurrence** exclusions over the 1,000 pilot rows' stored deal-breaker/trust quotes | 0 | 0 | 20 on rows whose raw text is not in the archive (role not derivable) |

Two limits on reading these:
- The fixtures are a small slice of the corpus. A registry rebuilt from them is a floor on what the corpus-wide registry holds, not an estimate of it.
- The 20 quote-recurrence exclusions have **no derivable role**, because the archive holds raw text for only 138 of the 1,000 rows. They are neither cleared nor confirmed.

No ordinary-role unit was excluded by `registry-hash` in any view available here.

### Tests — `fn/test/listen-fix-1b.test.js` (synthetic text only)

| Test | Predecessor `ba3c7bf` | HEAD |
|---|---|---|
| R1 mixed v3/v4 rows: separate basis counts, existing usage never ranked, legacy labelled | ✖ no `basisCounts` | ✔ |
| R2 replay never sends a ModTeam comment; result carries `grounding` | ✖ no `replayRow` | ✔ |
| R2 replay skips an excluded submission without reserving a cap slot | ✖ no `replayRow` | ✔ |
| R3 quote after the 8,000-char comment cut rejected; before it kept | ✖ no prompt view | ✔ |
| R3 quote after the 6,000-char post cut rejected; prompt built from the same view | ✖ quote validated against full text | ✔ |
| R4 all three audit readers cover the v4 quote fields | ✖ v4 quotes missing | ✔ |
| R4 contribution filter removes a v4 item quoting only a ModTeam comment | ✖ item kept | ✔ |
| R5 Arctic Shift post comments keep `distinguished` / `stickied` (stubbed fetch) | ✖ fields absent | ✔ |
| R5 Reddit OAuth top comments keep `distinguished` / `stickied` (stubbed fetch) | ✖ fields absent | ✔ |

On baseline `0fee3bf` the file does not load, because round 1's modules do not exist there (1 file-level failure).

### Acceptance checks (all original checks re-run)

1. **New tests:** 9/9 fail on `ba3c7bf` and 9/9 pass on HEAD. Round-1 tests: 12/12 still pass.
2. **Existing suite vs `0fee3bf`, zero delta:**
   - HEAD: 284 tests (263 + 12 + 9), 282 pass, 2 fail.
   - Same two pre-existing failures: the duplicate subreddit list, and the Windows-only CAS timing control. Cowork's Linux run showed the CAS test passing there.
3. **Syntax:** `node --check` passes on every changed or new JS file.
4. **Zero model calls:** the suite ran with every model, API and source env var unset and a network trap preloaded (33 processes). It logged 0 network attempts; the R5 tests replace `fetch` with an in-process stub.
5. **Secret guard:** see the receipt; clean at commit time.
6. **Public-data guard:** `public-data-guard.js` passes on the staged diff (see the receipt).
7. **Paths:**
   - filter/pipeline: `analysis-pipeline.js`, `analyze-worker.js`, `contribution-filter.js`
   - prompt/validator: `prompt-view.js`, `aoai.js`, `grounding-validator.js`
   - rollup: `rollup-engine.js`
   - audit readers: `quality-benchmark.js`, `audit.js`, `retag.js`
   - ingest: `sources/arcticshift.js`, `reddit.js`
   - replay: `scripts/quality-pilot.js`
   - the fixture check, the new test file, this report

   The analyze worker now reads the registry before the cap check rather than after. This is a cache read with no spend, so ordering is otherwise unchanged.

### Round-1 counts unchanged

Re-running the fixture check at HEAD reproduces every round-1 count above (e.g. packet arm A sourced-only-from-excluded: 45 / 70 / 27 / 22).

### What is NOT done (1b)

- No replay or reanalysis, no deploy, no merge. The approved ~40-record replay still needs its own go; it would now run through `replayRow`.
- Existing `raw` archives are not backfilled with comment role flags.
- The 20 quote-recurrence exclusions on rows without archived raw text remain unattributed.
- No boilerplate fingerprints are registered; `BOILERPLATE_FINGERPRINTS` still ships empty.
- No semantic item-versus-quote check, and no rubric v2.
- The R1 choice to keep `legacy` mentions on the ranked board, so it does not empty before reanalysis, is flagged for Cowork. The alternative is a legacy-free board that would be nearly empty until the corpus is reanalysed.
