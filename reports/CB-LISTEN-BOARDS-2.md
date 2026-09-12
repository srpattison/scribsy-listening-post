# CB-LISTEN-BOARDS-2 — item-level quote recurrence, registry-load degradation surfaced, two new subreddits

**This round does NOT close.** Per brief C8/§5 and the "Must" item on establishing live-read access in the first minutes: this build environment has no Azure Table Storage credentials and no function key for `/api/insights`, so acceptance rows A1–A5 and the live-health half of A6 are **DEFERRED-LIVE**. This is the identical, previously-documented environment constraint from `reports/CB-LISTEN-BOARDS-1.md` §2, re-confirmed live below rather than assumed. The code for S1/S3/S4/S5 is landed and unit-tested against fixtures faithful to the cited contamination shape; S2 is evaluated and not built. Founder-hands next action: run a live rollup on the deployed build and read `/api/insights?view=all&code=$KEY` against the rows below.

## 1. Per-item status

| Item | Verdict | Evidence |
|---|---|---|
| S1 — item-level exclusion by quote recurrence | LANDED (fixture-verified; live effect DEFERRED-LIVE) | `fn/src/lib/boilerplate-filter.js` (`buildQuoteRecurrenceIndex`, `isRecurringQuote`, `extractQuotes`); `fn/src/lib/rollup-engine.js` (quoteIndex wiring, minbar/trust call sites); `fn/test/rollup-quote-recurrence.test.js` (5 tests) |
| S2 — row-source matching | NOT BUILT — evaluated only, per brief's own "evaluate and report" instruction | §4 below |
| S3 — surface registry-load degradation | LANDED (fixture-verified; live health read DEFERRED-LIVE) | `fn/src/lib/rollup-engine.js` (`registryHealth` → `summary.boilerplateRegistryHealth`); `fn/src/functions/api.js` `health()`; `swa/index.html` `renderHealthBar`; `fn/test/rollup-registry-degradation.test.js` (3 tests) |
| S4 — normalisation | LANDED | `fn/src/lib/content-class.js` `normalizeText` (smart quotes/dashes folded before markdown/quote stripping); `fn/test/bot-boilerplate.test.js` (2 new tests) |
| S5 — two new subreddits | LANDED (code); NOT YET LIVE — see §5 caveat | `deploy.sh` `DEFAULT_SUBREDDITS_VALUE`; one-source-read evidence in A7 below |

An undeclared deferral is a defect per this repo's own standing rules, so it is declared here, first line, in the prescribed form: **this receipt does not fully satisfy the brief's acceptance list — A1–A5 and A6's live-health half are DEFERRED-LIVE.**

## 2. Environment check (brief's "FIRST MINUTES" requirement)

Confirmed, matching BOARDS-1 §2 exactly and re-verified live rather than assumed:

- No `local.settings.json` anywhere in the tree (`find` returned nothing).
- No `loop-admin` tool on PATH (`which loop-admin` → exit 1).
- `fn/node_modules` does not exist — `@azure/functions` is not installed, so `fn/src/functions/api.js` cannot be `require`d in this session (same constraint `fn/test/api-views.test.js`'s own header documents).
- Network egress works: `GET https://scribsy-listen-fn-2026.azurewebsites.net/api/ping` → **200** (anonymous, no key needed).
- `GET https://scribsy-listen-fn-2026.azurewebsites.net/api/insights?view=all` (no `code=`) → **`HTTP/1.1 401 Unauthorized`** (function-key auth, `fn/src/functions/api.js:127` `authLevel: 'function'`). No function key is available to this session (env-var reads of plausible credential names were themselves denied by the sandbox's own permission gate, independent of whether a value exists).

**Conclusion, stated per the brief's instruction: A1–A5 and A6's health-read half are DEFERRED-LIVE. The round does not close.**

## 3. S1 — item-level exclusion by QUOTE recurrence

**Root cause reused, not re-derived** (brief §2, superseded-argument warnings honored): the registry indexes whole bodies/titles; the analyzer emits a ~55-char sentence-level quote extracted *from* a body. `hash(sentence) != hash(body)` at any floor, so the registry rung structurally cannot catch this population no matter how it's tuned, and `minChars` was not touched (C2).

**Design**: `boilerplate-filter.js` now builds a `Map<"${sub}|${quoteHash}", Set<permalink>>` from `humanRows` — the same population that feeds the boards — over exactly two fields: `dealBreakers[].quote` and `trustSignals[].quote`. An item is excluded with reason `'quote-recurrence'` when its own quote hashes to a bucket with **more than 5** distinct permalinks in that subreddit (reusing the existing `BOILERPLATE_MIN_REPEATS`-style convention; configurable via `BOILERPLATE_MIN_QUOTE_REPEATS`, wired through `deploy.sh`'s settings-preservation guard like every other boilerplate knob). The length floor for hashing is a new, separate, lower constant (`BOILERPLATE_MIN_QUOTE_CHARS`, default 20) — deliberately far below the 120-char body floor, because that floor is exactly what would exclude nearly every ~55-char extracted quote and reproduce the original defect (brief §2 item 3, "fix shape (i) is KILLED BY MEASUREMENT" — this is a *different* mechanism, not a reopening of that one). Safety comes from the recurrence count, not the length floor, matching the brief's own framing: *"661 occurrences vs ordinary writer sentiment is not a close call."*

**Applies to quotes, never labels** (brief's explicit "Must" item, and the round's own over-exclusion guard, A5): `expected_baseline` and `pain_points` carry no field distinct from their own aggregation key — the string *is* the label (confirmed against the analyzer's JSON schema in `fn/src/lib/aoai.js`: `pain_points`/`expected_baseline` are `{type: 'array', items: {type: 'string'}}`, no `quote` sibling). Recurrence-checking those would suppress genuinely shared writer sentiment, so `excludeItem` only receives a `{ quote }` argument from the `dealBreakers` and `trustSignals` call sites; `baselineCounts` and `painCounts` call sites are byte-for-byte unchanged from BOARDS-1. `minbar.baselineCounts` therefore remains out of scope exactly as brief §4 rules — confirmed, not re-argued.

**Fixture evidence** (`fn/test/rollup-quote-recurrence.test.js`, all 5 pass):
```
ok 1 - S1: a quote recurring verbatim across many distinct permalinks is excluded with no registry entry
ok 2 - S1: markdown-bold and smart-quote variants of the same sentence collapse to one recurring hash (S4)
ok 3 - S1 never applies to LABELS: many genuinely distinct quotes sharing one label all survive
ok 4 - S1 does not reach pain_points or expected_baseline (no separate quote field — out of scope, brief §4)
ok 5 - with an unregistered, non-recurring quote, the same shape leaks through unfiltered (proves S1 can fail)
```
Test 1 is the PASSING control the round requires (not only a failing-seed list): an 8-way recurring quote with **zero** registry entries is excluded via `byReason['quote-recurrence']`, while a genuine one-off deal-breaker on the same board survives untouched. Test 5 is the matching negative control (below-threshold repeats leak, proving the check can fail). Test 3 is the label-safety control the brief names by name (`"content warnings": 363`) at smaller scale: 8 posts sharing one label with 8 *distinct* verbatim quotes all reach the board, `byReason['quote-recurrence'] === 0`.

## 4. S2 — row-source matching: evaluated, not built

Per the brief, S2 is "evaluate and report," and ships only if it beats S1 alone. It does not, for a structural reason found by reading the code (not by live measurement — this section requires no live corpus):

1. **The row shape the rollup operates on has no body field to hash.** `rollup-engine.js`'s `parseRows()` reads only `title` from `listAnalyzedPosts()` rows; `body`/`selftext` lives solely in the raw archive blob (`store.js` `saveRaw`, confirmed: `body` never appears as a column the analyzed-posts Table row carries). Implementing "hash the row's body against the registry" at rollup time would require a raw-blob read per row — a new per-row I/O pattern the rollup does not have today, which is a materially larger change than a corrective round's scope, not a small addition.
2. **Even given the body, exact whole-row hashing reproduces this round's own root cause one level up.** The documented hazard (brief §3 S2) is Reddit automod appending rule text to an otherwise-genuine human post. An appended body is a *different string* from the registry's standalone rule-text entry — `hash(title-caught-registry-text)` was already tuned for whole-body/whole-title matches, so `hash(human-post + appended-rule-text) != hash(rule-text-alone)`, the identical granularity mismatch S1 exists to fix, restated at the row level. It would systematically **miss** exactly the case it was proposed to catch.
3. **What it *would* catch — a row whose entire body is a byte-identical copy of registered text — is already caught.** `content-class.js`'s existing row-level `repeat-hash` classification (via `classifyRow`/`classifyUntagged`, run before any item-level filter) already flags whole-body duplicates as `contentClass: 'boilerplate'`, which removes the row from `humanRows` before any item-exclusion logic runs at all. The marginal population S2 would add is bounded by the automod-append case in (2), which it structurally can't catch.

**Conclusion: ship S1 only, as the brief instructs when S2 underperforms.** No code changes were made for S2; nothing was removed either.

## 5. S3 — registry-load degradation, health-visible

Reused the settled degradation-surfacing pattern named in the brief's binding constraints (per-section health counter, explicit "unavailable" UI state) rather than inventing a new one.

- `rollup-engine.js`: the existing `try { loadRegistryForSubs... } catch { context.warn(...) }` block now also records `registryHealth = { degraded: true, error, checkedAt }` on failure (`{ degraded: false, error: null }` on success), folded into the rollup summary as `summary.boilerplateRegistryHealth` — persisted to the `rollup-health` aggregate exactly like `featuresHealth` already is.
- `fn/src/functions/api.js` `health()`: now passes `boilerplateRegistryHealth` through from the `rollup-health` aggregate (previously this block silently dropped every field of `summary` except a named few — `featuresHealth`/`boilerplateExcluded` were already being dropped this way too, pre-existing and out of this round's scope).
- `swa/index.html` `renderHealthBar`: now checks `h.boilerplateRegistryHealth.degraded` independently of the existing failed-sections list (a registry-load failure never fails a *section* — the run still returns `ok: true` — so it would never otherwise appear in the health bar at all, which is exactly the BOARDS-1 gap: *"boilerplateRegistry.error: null — the try/catch degradation is NOT firing"* looked identical to *"nothing to report"* from the outside).
- Quote-recurrence (S1) is architecturally independent of the registry — it is built from `humanRows` with no store I/O — so a registry outage degrades one rung, not the whole item filter. Verified explicitly in the forced-throw test below.

**Fixture evidence** (`fn/test/rollup-registry-degradation.test.js`, all 3 pass — this is the test the brief names as missing: *"no test covers the branch (the fake store cannot throw)"*; this suite's fake store does throw, on demand, for exactly the `boilerplate-registry` partition):
```
ok 1 - a forced registry-load throw is health-visible, not just warn-logged
ok 2 - with the registry healthy, the same run reports degraded: false (proves the signal can be negative too)
ok 3 - api.js health() reads boilerplateRegistryHealth from the rollup aggregate
```
Test 1 asserts, against a store whose `getAggregate('boilerplate-registry', ...)` throws: `summary.ok === true` (a registry outage must not fail the run — round-3 contract), `summary.boilerplateRegistryHealth.degraded === true` with the simulated error message, `minbar.excluded.byReason.registry === 0` (the rung really is down), and `minbar.excluded.byReason['quote-recurrence'] >= 8` (S1 still fires — defense in depth, not a full outage). Test 3 is a source-inspection test, the same technique `fn/test/api-views.test.js` uses for `VIEWS`, because `api.js` cannot be `require`d in this environment (no `@azure/functions` in `node_modules` — confirmed, see §2).

## 6. S4 — normalisation

`content-class.js`'s `normalizeText` (the single shared normaliser — no second one added, per the brief's explicit instruction) now folds smart quotes (`‘’‚′` → `'`, `“”„″` → `"`) and dashes (`‒–—―` → `-`) to ASCII **before** the existing markdown-emphasis strip, and that strip's character class now also removes quote characters (straight and now-folded) — so `**bold**`, curly-quote, and plain copies of one sentence all collapse to the same normalized string and the same hash. This directly fixes the brief's cited variant pair: `"AI-generated feedback and 'reviews' is also not allowed."` vs `"**AI-generated feedback and "reviews" is also not allowed.**"`. Verified against the *existing* `normalizeText`/`hashIfEligible`, not a parallel normaliser — both the registry (`boilerplate-registry.js`) and S1 (`boilerplate-filter.js`) call the same function, so both benefit automatically.

The brief's separately-flagged "AI-generated feedback allowed" negation-dropped entry is confirmed to be an analyzer labelling artifact (a distinct extraction from a distinct piece of text, not a normalisation variant of the recurring quote) and was correctly left untouched, per the brief's own instruction not to attempt fixing it with normalisation.

**Fixture evidence** (`fn/test/bot-boilerplate.test.js`, 2 new tests, both pass):
```
ok - CB-LISTEN-BOARDS-2 §3 S4: markdown emphasis and smart quotes collapse to one hash
ok - CB-LISTEN-BOARDS-2 §3 S4: smart dashes fold to a hyphen
```

**Deviation flagged (C6/C7 — measured, not assumed):** `normalizeText` lives in `content-class.js`, which also holds the row-level `classifyRow`/`classifyUntagged`/`buildRepeatIndex` functions C2 says not to modify. Those three functions, `DEFAULT_MIN_CHARS` (120), `DEFAULT_MIN_TITLE_CHARS` (40), and `DEFAULT_MIN_REPEATS` (5) are **byte-for-byte unchanged** — confirmed by the file diff (only `normalizeText`'s regex chain changed) and by the unmodified row-level tests in `bot-boilerplate.test.js` all still passing unchanged. C2's target is the classification threshold/logic, not this file as a whole — and the brief's own S4 instruction directs the change into this exact function by name ("Verify against the existing `normalizeText`"), so the two instructions are read together rather than in conflict. One second-order effect worth naming honestly: stripping quote characters shortens normalized length by a small, bounded amount (the count of quote/dash characters in the string), which could in principle move a text that was previously exactly at the 120-char boundary to just under it. This is judged negligible (quote/dash counts in real rule text are a handful of characters against a 120-char floor with documented headroom) but cannot be verified against the live corpus from this environment — folded into the DEFERRED-LIVE status of A4, not asserted as risk-free.

## 7. S5 — two new subreddits

`deploy.sh`'s `DEFAULT_SUBREDDITS_VALUE` (the repo's single subreddit-list source — `fn/test/config.test.js`'s "exactly one subreddit list, in deploy.sh" test still passes, confirming no second copy was introduced) now ends `...,BetterOffline,bookcovers,writeresearch`. Neither is an enclave sub, so `SUB_TAGS` is unchanged — a plain `reddit` cohort frame, same as most of the existing list.

**One-source-read verification (brief's explicit "Must" — lane A flagged this as inferred, not measured; measured here):**
```
fn/src/functions/ingest.js:21:  const subreddits = () => config.subreddits();
fn/src/lib/rollup-engine.js:696:  (env.SUBREDDITS || '').split(',')...
```
`config.subreddits(env)` (`fn/src/lib/config.js`) reads `env.SUBREDDITS` directly. The collector (`ingest.js`, both the Arctic and OAuth ingest frames) and the rollup's `discovery` section read the identical environment variable, through the identical config accessor for the collector's case. Confirmed by source read, not inferred.

**Dual-frame wiring**: both frames are pre-existing, subreddit-agnostic code paths (`ingestRedditArctic` walks `subreddits()` — Arctic Shift; `ingestBluesky` walks `bsky.streams()` — unrelated to `SUBREDDITS`). Adding two names to `SUBREDDITS` routes them through the existing Arctic Shift archive frame automatically; no Reddit-API-specific code was touched or added, so the "Reddit self-serve is dead" constraint is satisfied by construction, not by a new check.

**Caveat — the settings-preservation guard cuts both ways (brief's explicit "Must": verify the entries *survive* the guard, not merely parse):** `deploy.sh`'s `resolve "SUBREDDITS" "${SUBREDDITS:-}" "$DEFAULT_SUBREDDITS_VALUE"` preserves whatever is **already live** over the shipped default whenever the `SUBREDDITS` environment variable is not explicitly exported at deploy time (§10.4, tested by `fn/test/deploy-settings.test.js`, unmodified and still passing). The live app already has a `SUBREDDITS` setting (23 subs, per the BOARDS-1 baseline). **This means updating the default alone does NOT put the two new subs on the live app on the next `bash deploy.sh` run** — the guard will preserve the current live 23-sub value instead, exactly the behavior it exists to guarantee. This is not a defect in the guard or in this change; it is the reason this item's status is LANDED (code) / NOT YET LIVE. Landing it live requires the operator to export `SUBREDDITS` explicitly on the next deploy, e.g.:
```
SUBREDDITS='writing,writers,nanowrimo,WritingWithAI,selfpublish,fantasywriters,scifiwriting,PubTips,KeepWriting,writingadvice,AIWritingLounge,NewAuthor,FictionWriting,FanFiction,AO3,eroticauthors,BetaReaders,DestructiveReaders,worldbuilding,Screenwriting,writingcirclejerk,selfpublishing,BetterOffline,bookcovers,writeresearch' bash deploy.sh
```
This is a founder-hands deploy step (C1), named explicitly here so it is not silently assumed to happen on its own.

## 8. Acceptance — A1 through A7

Per C7, each row states its instrument and quotes one raw result.

- **A1** ("AI-generated feedback" strings fall from 145 to near zero) — **DEFERRED-LIVE**. Instrument: `GET /api/insights?view=all&code=$KEY`. No key available in this environment (§2: `401 Unauthorized` without one). Baseline cited from the brief, not re-measured: 145.
- **A2** (the two specific board entries gone or excluded) — **DEFERRED-LIVE**, same instrument/reason as A1. Baseline cited: count 661 / count 136.
- **A3** (new `byReason` bucket non-zero; registry/stickied buckets don't regress below 24/5 and 2/5) — **DEFERRED-LIVE** for the live corpus (same instrument). Fixture-level corroboration only, not a substitute (BOARDS-1's own lesson, DEFERRED-LIVE bus 1029, honored): `fn/test/rollup-quote-recurrence.test.js` test 1 shows `minbar.excluded.byReason['quote-recurrence'] >= 8` on a fixture with zero registry entries, and the S1 code path checks the registry rung strictly before the quote-recurrence rung (`isBoilerplateText` returns first in `excludeItem`), so a registry-caught item is never double-counted or reclassified into the new bucket — confirmed by `rollup-boilerplate-boards.test.js` test 1 (seeded-registry case) still reporting `byReason.registry >= REPEATS` unchanged.
- **A4** (`rules.totalExcluded` stays ≥ 1,682) — **DEFERRED-LIVE**, same instrument. By code inspection: the `rules` section (`rollup-engine.js`, `nonHumanRows.length`) and the row-level `contentClass` classification it reads are untouched by this round except for `normalizeText`'s Unicode folding (§6 deviation) — no line in `classifyRow`/`classifyUntagged`/the `rules` section itself changed.
- **A5** (genuine short items — beta readers, private manuscript sharing, authorship provenance, ai-usage disclosure — still present with non-trivial counts; the over-exclusion guard) — **DEFERRED-LIVE** for the live corpus, same instrument. Fixture-level corroboration: `rollup-quote-recurrence.test.js` test 3 (8 genuinely distinct quotes sharing one label all reach the board, full count preserved) and test 4 (pain-point/baseline phrases untouched by S1) are the fixture-scale version of this exact guard; `rollup-boilerplate-boards.test.js` test 1's control row (`'bot reviews are worthless'`) continues to survive unchanged.
- **A6** (forced registry-load throw is health-visible + fails a test) — **PARTIALLY DISCHARGED**. Unit test: **DISCHARGED**. Instrument: `node --test test/rollup-registry-degradation.test.js`. Raw result: `ok 1 - a forced registry-load throw is health-visible, not just warn-logged` / `ok 3 - api.js health() reads boilerplateRegistryHealth from the rollup aggregate`. Live health read: **DEFERRED-LIVE** (same `/api/insights?view=health` auth constraint as A1–A5).
- **A7** (SUBREDDITS contains both new subs; collector reads the same variable) — **DISCHARGED**. This row's own instrument is a config read + one source read, neither of which needs live access. Instrument: `grep` + file read. Raw result: `deploy.sh:53: DEFAULT_SUBREDDITS_VALUE='...,BetterOffline,bookcovers,writeresearch'`; `fn/src/functions/ingest.js:21: const subreddits = () => config.subreddits();` reading the same `env.SUBREDDITS` as `fn/src/lib/rollup-engine.js:696`. (Caveat carried from §7: the *default* contains both subs; the *live app setting* does not yet, pending a founder-hands redeploy with `SUBREDDITS` explicitly exported.)

**A5 note, as the brief requires:** this is the row that stops this round from trading one broken board for another, and it is exactly the row this environment cannot verify against real data. That is stated plainly, not glossed over.

## 9. Mechanical acceptance

**Test suite, zero-delta check.**
Baseline, this branch's anchor commit (`origin/main` HEAD, `0a6758a37747a9eac830cf0eac85c6918f8899fb`):
```
$ node --test test/*.test.js
# tests 198
# pass 196
# fail 2
not ok 7 - test/daily-cap.test.js
not ok 11 - test/provenance.test.js
```
This branch, after S1/S3/S4/S5 (commit `d7dd6f72ef127128e4fbd935b5504e7be91c7ef8`):
```
$ node --test test/*.test.js
# tests 208
# pass 206
# fail 2
not ok 7 - test/daily-cap.test.js
not ok 11 - test/provenance.test.js
```
**Zero delta**: same two pre-existing reds, unmodified and not silently fixed (confirmed by re-running the exact baseline tree via `git stash` before writing this report). +10 new tests, all passing, 0 regressions. One existing test (`rollup-boilerplate-boards.test.js`'s second test) was edited, not just left alone — flagged as a deviation immediately below.

**Secret guard.**
```
$ git status --porcelain | grep -iE ".env|local.settings|credential|secret"
(no output)
```
No `.env`, `local.settings.json`, or credential-shaped file staged.

**Only intended paths changed.**
```
$ git show --stat HEAD
 deploy.sh                                   |  18 ++-
 fn/src/functions/api.js                     |   6 +
 fn/src/lib/boilerplate-filter.js            |  98 +++++++++++++--
 fn/src/lib/config.js                        |  16 +++
 fn/src/lib/content-class.js                 |  13 +-
 fn/src/lib/rollup-engine.js                 |  37 +++-
 fn/test/bot-boilerplate.test.js             |  23 ++
 fn/test/rollup-boilerplate-boards.test.js   |  14 ++-
 fn/test/rollup-quote-recurrence.test.js     | 177 ++++++++++++++++
 fn/test/rollup-registry-degradation.test.js | 116 ++++++++++
 swa/index.html                              |  18 ++-
 11 files changed, 516 insertions(+), 20 deletions(-)
```
No `.github/workflows/**` touched (C4/HARD LIMIT). No file under `fn/src/functions/reanalyze.js` or `fn/src/lib/aoai.js` touched — `git diff --stat` against both is empty.

**SCHEMA_VERSION unchanged.**
```
fn/src/lib/taxonomy.js:66:const SCHEMA_VERSION = 3; // v1 base · v2 strategy dims · v3 tool sentiment + embeddings
```
Untouched — `taxonomy.js` does not appear in this round's diff at all.

## 10. Deviations from the brief

1. `fn/test/rollup-boilerplate-boards.test.js`'s second test ("with no registry seeded, the same corpus leaks the rule text") reduced its repeat count from 12 to 3, and gained an assertion. S1 (quote recurrence) is deliberately independent of the registry, so at 12 repeats the *new* mechanism this round adds now also catches that fixture — which is correct behavior, but it invalidated the test's original claim that the corpus leaks with *no* filtering mechanism active. Reworded to isolate "the registry rung specifically can fail" at a repeat count below both mechanisms' thresholds, and added an explicit `byReason['quote-recurrence'] === 0` assertion so the isolation is checked, not assumed. This is the one existing (not new) test file this round edited.
2. §6's `normalizeText` change touches a file (`content-class.js`) that also holds the row-level contentClass layer C2 says not to modify — addressed as a deviation, with the specific functions/constants confirmed unchanged, because the brief's own S4 instruction requires reusing this exact function.
3. Two new config knobs were added (`BOILERPLATE_MIN_QUOTE_CHARS` / `BOILERPLATE_MIN_QUOTE_REPEATS`, default 20/5) rather than hardcoding S1's threshold, following this repo's existing convention (`config.js`'s "mechanical knobs: defensible constants allowed" section) for every other boilerplate-detection parameter. Wired through `deploy.sh`'s settings-preservation guard identically to the existing `BOILERPLATE_MIN_*` settings.
4. None beyond the above. Everything else matches brief §3–§7 as specified.

## 11. What is NOT done

- A1–A5 and A6's live-health half: **DEFERRED-LIVE**, not run, per C8. This round does not close.
- S5 is code-complete but **not live**: the settings-preservation guard will keep the current 23-sub list on the next plain `bash deploy.sh` unless `SUBREDDITS` is explicitly exported with the two new subs included (exact command in §7).
- S2: evaluated and explicitly not built, per the brief's own conditional instruction.
- No merge, no deploy, no rollup trigger, no drain — none attempted, per C1/C5 and the standing no-drain fence.

## 12. Next action, and whose hands

1. **Founder**: review and merge this PR (`feat/CB-LISTEN-BOARDS-2` → `main`) — no auto-merge, per standing ruling.
2. **Founder**: deploy with `bash deploy.sh`, exporting `SUBREDDITS` explicitly per §7 if the two new subs are wanted live in this same pass (otherwise they can be added in a later, separate deploy).
3. **Founder**: trigger a rollup (`POST /api/rollupNow?code=$KEY`) on the deployed build.
4. **Founder or next CODE round**: read `GET /api/insights?view=all&code=$KEY` (and `view=health`) and discharge A1–A6 against the live corpus, quoting raw output, per this brief's own acceptance instrument. Standing quarantine on Deal-breaker/Trust/Minimum-bar numbers in front of Brian/investors/marketing remains in force until that re-roll happens and is read clean.

## 13. Anchor and SHAs

- Anchor (per the brief's DECLARED UNRESOLVED anchor instruction: `git rev-parse HEAD` at clone): `0a6758a37747a9eac830cf0eac85c6918f8899fb` — matches `origin/main` HEAD and the predecessor's cited `deployedSha`. This is the branch point, not an assertion about what is currently deployed (live deployed head is cited elsewhere as `f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c`; this round does not re-derive or assert deploy state from either SHA).
- Branch head SHA before this report's own commit (final head will advance by one commit once this file is committed — labeled per the repo's own known-pattern note, not a discrepancy): `d7dd6f72ef127128e4fbd935b5504e7be91c7ef8`.
