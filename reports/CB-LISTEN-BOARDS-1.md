# CB-LISTEN-BOARDS-1 — registry-aware boards, AI feature split, competitor aliases, topic dedupe, rules section reachable

| § | Item | Verdict | Evidence |
|---|---|---|---|
| 4.1 | Registry-aware exclusion on boards (dealBreakerBoard, trustBoard, baselineCounts/baselineTop, painCounts, strategyBrief evidence pack) | LANDED | `fn/src/lib/boilerplate-filter.js` (new); `fn/src/lib/rollup-engine.js` minbar/trust/distributions/brief sections; `fn/test/rollup-boilerplate-boards.test.js` (2 tests) |
| 4.2 | Fix the AI / non-AI feature split (C3 catch-block fallback) | LANDED | `fn/src/lib/rollup-engine.js` `features` section; `fn/test/rollup-feature-split.test.js` (4 tests) |
| 4.3 | Normalise competitor names (COMPETITOR_ALIASES, variants[]) | LANDED | `fn/src/lib/taxonomy.js`; `fn/src/lib/rollup-engine.js` `competitors` section; `fn/test/rollup-competitor-alias.test.js` (3 tests) |
| 4.4 | Topic tags: de-duplicate, lock existing scoping, bounded audit | LANDED | `fn/src/lib/rollup-engine.js` heatmap + distributions sections; `fn/test/rollup-topic-tags.test.js` (3 tests); audit table below |
| 4.5 | Make the "Excluded: bot & boilerplate" section reachable | LANDED | `fn/src/functions/api.js` VIEWS; `swa/index.html` data-driven section count; `fn/test/api-views.test.js` (3 tests) |
| 4.6.1 | Behavioural — no top-10 item is registry/contentClass/stickied/distinguished text | LANDED (fixture-verified) — **could not be run against the live production corpus; see §"Environment constraint" below** | `fn/test/rollup-boilerplate-boards.test.js`; before/after board dumps below are from the test fixture, not production |
| 4.6.2 | Behavioural — "AI-powered wishes" is non-empty | LANDED (fixture-verified, same caveat) | `fn/test/rollup-feature-split.test.js` test (b), fixture shaped like `aiwritinglounge/1uozxep` |
| 4.6.3 | Behavioural — AO3 is one row, variants.length === 2, summed mentions | LANDED (fixture-verified, same caveat) | `fn/test/rollup-competitor-alias.test.js` |
| 4.6.4 | Behavioural — rules section retrievable via view=all and view=rules, non-zero excluded count | LANDED (code + unit-level; no live HTTP host in this environment — see below) | `fn/src/functions/api.js` VIEWS; `fn/test/api-views.test.js`; rules payload already carries `totalExcluded` (pre-existing, `rollup-engine.js:745`) |
| 4.6.5 | Behavioural — excluded.count present and non-zero on every §4.1 section | LANDED | `fn/test/rollup-boilerplate-boards.test.js` asserts `minbar.excluded.count`, `trust.excluded.count`, `brief.excluded.count` all > 0 |
| 4.6.6 | Mechanical — zero delta on test suite vs baseline SHA | LANDED | See "Test suite" below: 181/183 pass at baseline (cb97152), 196/198 pass at HEAD — same 2 pre-existing reds, +15 new, 0 regressions |
| 4.6.7 | Mechanical — secret guard | LANDED | `git diff --cached --name-only` pasted below — no `.env`/`local.settings.json`/etc. |
| 4.6.8 | Mechanical — only intended paths changed | LANDED | `git show --stat` pasted below (added after commit) |
| 4.6.9 | Mechanical — SCHEMA_VERSION unchanged | LANDED | `taxonomy.js:66` pasted below, value and line both untouched |
| 4.6.10 | Mechanical — reanalyze.js untouched, aoai.js unchanged | LANDED | `git diff --stat` against both files below (empty) |
| 4.6.11 | Mechanical — every red-first test's failing output pasted before the fix | LANDED | See "Red-first tests" below |

---

## 0. Header

- Round: CB-LISTEN-BOARDS-1
- Repo: `srpattison/scribsy-listening-post`
- Base used: `cb9715273ba175af7c4d0536ae0aeb9a3a5d960e` (origin/main HEAD at session start) — **not** `f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c` as the brief states. See "Base SHA deviation" below.
- Branch: `feat/CB-LISTEN-BOARDS-1`
- Date: 2026-09-04

## 1. Base SHA deviation (reported per instructions, not a STOP condition)

The brief cites `Base: main @ f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c (deployed)`. At session start, `origin/main` HEAD was actually `cb9715273ba175af7c4d0536ae0aeb9a3a5d960e` (merge of `feat/CB-LISTEN-ACCEPT-RESTAMP-1`), one merge ahead of the brief's cited SHA:

```
$ git diff --stat f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c cb9715273ba175af7c4d0536ae0aeb9a3a5d960e
 reports/CB-LISTEN-ACCEPT-RESTAMP-1.md | 301 ++++++++++++++++++++++++++++++++++
 1 file changed, 301 insertions(+)
```

That intervening commit only adds a report file — no code the brief cites (`rollup-engine.js`, `api.js`, `taxonomy.js`, `boilerplate-registry.js`, `content-class.js`) changed between the two SHAs. All line numbers the brief cites were verified against the actual checkout and matched exactly (e.g. `minbar` build at `rollup-engine.js:434`, `trust` at `:455`, `competitors` at `:559`, `rules` at `:680`, `brief` at `:700`). Branched from the real `origin/main` HEAD (`cb97152...`) rather than the stale SHA, since that is what a PR against `main` will actually be based on.

## 2. Environment constraint on the "behavioural" acceptance checks

This build environment has **no Azure Table Storage credentials, no `local.settings.json`, no `loop-admin` tool, and no running Functions host** (confirmed: no `local.settings.json` anywhere in the tree, `@azure/functions` is not even installed in `node_modules` — the whole `fn/test` suite is written to run on Node built-ins alone, with `store`/`aoai` faked). There is no way from this session to run the real rollup over the real analysed corpus (120 stamped rows, 167 quotes) or to hit a live `/api/insights` endpoint, and §7 of the brief itself confirms production deploy and the next rollup run are founder-hands (Cloud Shell), not an agent action.

Per §4.6's own acceptance items, "re-run the rollup" is honored here as: **the full `runRollup()` entry point, exercised end-to-end against fixtures shaped exactly like the cited real-world contamination** (the r/BetaReaders rule text, the `aiwritinglounge/1uozxep` row shape, the AO3 spelling variants) with fake but structurally faithful storage. This is the same technique every existing test in `fn/test/rollup-endtoend.test.js` and `fn/test/bot-boilerplate.test.js` already uses to verify rollup behaviour without a live store. The before/after board dumps in §3 below are from these fixtures, not from the live 120-row corpus. **Verifying the fix against the actual production corpus requires the founder's post-deploy `rollupNow` step (§7/§8) or a session with `loop-admin`/live storage access** — this could not be done here and is flagged explicitly rather than silently assumed to pass.

## 3. Premise corrections — confirmed against the local checkout

- **C1** (registry not applied at item level): confirmed. `rollup-engine.js:776-777` splits `humanRows`/`nonHumanRows`; every sentiment section already reads `humanRows`/`humanAiRows`. `boilerplateRegistry` had exactly one read call site before this round (`api.js` `health()` → `summarize()`); no section writer read it. Fixed per §4.1.
- **C2** (`rules` reader omission, not writer failure): confirmed. `VIEWS` at `api.js:17` had 15 entries, no `'rules'`. The writer at `rollup-engine.js:680` (now `:726` after the §4.1 diff shifted line numbers) is unconditional, synchronous, string-only work with no I/O — it cannot throw from storage/network, and `fn/test/rollup-endtoend.test.js` (pre-existing, unmodified) already asserts `rules` is written with no `error` key, on every run including the empty-corpus and AOAI-outage cases. **Confirmed reader-only** — no writer-side fix was needed or made.
- **C3** (feature split catch-block drops `aiRelated`): confirmed and fixed. See §4.2.
- **C4** (heat map already `ai_related`-scoped; per-row dedup missing): confirmed. The locking test in `rollup-topic-tags.test.js` ("a row with ai_related=false contributes zero...") **passes unmodified on the pre-fix code**, proving the scoping was already correct. The dedup defect was real and is fixed.

## 4. swa/index.html findings (§8 open question)

The file read cleanly in this session (783 lines; no 504). Two things the brief asked to check:

1. **§4.2 predicate**: `swa/index.html:436` — `board.filter((x) => x.aiRelated)` for the "AI-powered wishes" bucket. This is exactly `featureBoard[].aiRelated`, matching the brief's assumption. **No frontend change needed for §4.2.**
2. **§4.5 hardcoded section count**: `swa/index.html` (pre-fix) hardcoded the literal string `` `${names.length} of 15 sections unavailable}` `` in `renderHealthBar`. Investigation found this "15" is **not** the `VIEWS` array length (which was 15 pre-fix, 16 post-fix) — it is a separate, coincidental count: the number of `track(section(...))` calls in `render()`, which **already included `'rules'`** before this round (the dashboard already had a `#rules` div and a `renderRules()` function wired up, just fed by data the reader could never actually return). So the tracked-section count stays 15 even after adding `'rules'` to `VIEWS` — it was never wrong at "15", just hardcoded. Per the brief's explicit instruction to make it data-driven regardless, `render()` now counts its own `track()` calls (`trackedTotal`) and `renderHealthBar` interpolates that instead of the literal. This is a robustness fix against future drift, not a correction of a wrong number today. **Contradiction flagged as instructed**: the brief's framing ("the section count becomes 16") does not hold for this specific hardcoded string, because it was already counting `rules` as one of its 15 tracked sections.
3. **`snapshot`**: has its own `view=snapshots` handler (`api.js:130-133`, unchanged). Per the brief, left out of `VIEWS` — recorded explicitly here so the 17-vs-16 question doesn't resurface.

## 5. §4.4(c) — bounded audit of every `r.topics` consumer in rollup-engine.js

| Consumer | Location (pre-fix line) | Scoped to humanAiRows? | Deduped per row? | Feeds a user-facing count? | Action |
|---|---|---|---|---|---|
| `buildRecurrenceIndex` (`topicThreads`) | ~L48 | reads `humanRows` (salience index, broader than AI-only by design) | N/A — accumulates into a `Set` per topic, immune to per-row duplicates | No — feeds internal salience ranking, never displayed as a count | Not changed |
| `heatmap.heat` / `heatmap.heatBySub` | ~L344-351 | Yes (`humanAiRows`) | **No (fixed)** | Yes — topic heat map, directly rendered | **Fixed** |
| `distributions.topicTotals` | ~L377 | Yes (`humanAiRows`) | **No (fixed)** | Yes — feeds `brief`'s `topTopics` evidence (Strategic Answers) and the `snapshot` section | **Fixed** |
| `resonance` topic membership tests (`r.topics.includes(...)`) | ~L591-594 | reads `humanRows` | N/A — boolean membership test, immune to duplicates | No — not a count | Not changed |
| `quotes[].topics` (per-quote array, displayed as chips) | ~L526 | Yes (`humanAiRows`) | Not deduped | Display of the raw array, not an aggregate count | Not changed — reported only, out of the stated fix scope (a display artifact, not a "topic count") |

Per the brief's own bound ("fix only those the audit shows are both unscoped and feed a user-facing topic count"), two consumers qualified and were fixed; the rest are reported, not changed.

## 6. Before/after board dumps (fixture-driven — see environment-constraint note in §2)

From `fn/test/rollup-boilerplate-boards.test.js`'s second test ("with no registry seeded..."), which reproduces the pre-fix behaviour on the exact same fixture used to prove the fix:

**Before (no registry / pre-fix shape) — `dealBreakerBoard` contains the contaminated item:**
```
minbar.dealBreakerBoard includes { item: 'no ai feedback allowed', kind: 'ai-policy', count: 12, ... }
minbar.excluded.byReason.registry === 0
```

**After (registry seeded, fix applied) — same fixture, first test:**
```
dealBreakerBoard top-10:  'no ai feedback allowed' ABSENT (12 items excluded, byReason.registry >= 12)
trustBoard.breaks top-10: 'explicit ban on ai-generated feedback' ABSENT
trustBoard.builds top-10: 'ai disclosure required upfront' ABSENT
baselineTop:               rule-text entry ABSENT; minbar.baselineCounts is empty (its only entry was registry text)
Over-exclusion control:    'bot reviews are worthless' (genuine, unregistered) SURVIVES in dealBreakerBoard
minbar.excluded.count >= 12, trust.excluded.count >= 24, brief.excluded.count > 0
```

AO3 (`fn/test/rollup-competitor-alias.test.js`):
```
Before (no aliasing): board has 2 rows — 'archive of our own' (3 mentions), 'AO3' (2 mentions)
After:                board has 1 row — { tool: 'AO3', mentions: 5, variants: ['archive of our own', 'AO3'] }
Control:              'Scrivener' (1 mention) stays separate — never merged
```

Feature split (`fn/test/rollup-feature-split.test.js`, test (b), fixture shaped like `PartitionKey=aiwritinglounge, RowKey=1uozxep`):
```
Before (pre-fix fallback): featureBoard: [{ feature: 'ai continuity checker', count: 1, examples: [] }]  — no aiRelated key at all → AI bucket empty
After:                      featureBoard: [{ feature: 'ai continuity checker', count: 1, aiRelated: true, examples: [...] }] → AI bucket non-empty
```

## 7. Red-first tests — failing output before the fix

All five new test files were run against the pre-fix tree and captured failing before any implementation code was written, per the brief's red-first rule.

**`rollup-boilerplate-boards.test.js`** (2/2 failing):
```
not ok 1 - registry-recorded item text is excluded from every affected board; a genuine one-off survives
  error: 'registry-matched deal-breaker must not reach dealBreakerBoard top-10'
not ok 2 - with no registry seeded, the same corpus leaks the rule text (proves the check can fail)
  error: "Cannot read properties of undefined (reading 'byReason')"
```

**`rollup-feature-split.test.js`** (4/4 failing):
```
not ok 1 - (a) the degraded fallback still carries a boolean aiRelated...
  error: every entry must carry a boolean aiRelated, got {"feature":"ai outline generator","count":2,"examples":[]}  (actual: 'undefined', expected: 'boolean')
not ok 2 - (b) end-to-end on a fixture shaped like the real contaminated row: the AI bucket is non-empty
  error: 'the AI bucket must not be empty for a corpus that is entirely ai_related feature requests'
not ok 3 - (c) degraded is reflected in rollup-health, not only inside the section payload
  error: 'rollup-health summary must carry a featuresHealth block'
not ok 4 - clusteredNames/totalNames record the slice(0, 400) truncation rather than hiding it
  error: undefined !== 5
```

**`rollup-competitor-alias.test.js`** (2/3 failing; the third passed both before and after, as expected — it needs no aliasing):
```
not ok 1 - both AO3 spellings collapse into one board row with the summed mention count
  error: mentions must equal the sum of both spellings (2 !== 5)
not ok 2 - a trailing parenthetical is stripped before alias lookup
  error: 2 !== 1
ok  3 - an unmapped tool name is never dropped
```

**`rollup-topic-tags.test.js`** (2/3 failing; the locking test passed as designed):
```
not ok 1 - a row with a repeated topic slug contributes 1, not 2, to heat and heatBySub
  error: heat must count the row once for the duplicated slug (2 !== 1)
ok  2 - locking test: a row with ai_related=false contributes zero... (must already pass on main) — PASSED, as required
not ok 3 - distributions.topicTotals also de-duplicates per row
  error: 2 !== 1
```

**`api-views.test.js`** (3/3 failing, matching the brief's own claim "all three fail on f0ea25fc"):
```
not ok 1 - VIEWS includes rules
not ok 2 - view=all would serve a rules key
not ok 3 - view=rules would not 400
```

All 15 pass after the corresponding fix (see full-suite run below).

## 8. Mechanical acceptance

**Test suite, zero-delta check.** Baseline run at `cb9715273ba175af7c4d0536ae0aeb9a3a5d960e` (`origin/main` HEAD — see §1 for why this SHA rather than `f0ea25f`; the two are code-identical for every file this round touches):
```
$ node --test test/*.test.js
# tests 183
# pass 181
# fail 2
not ok 6 - test/daily-cap.test.js
not ok 10 - test/provenance.test.js
```
HEAD (this branch, after all fixes + 5 new test files):
```
$ node --test test/*.test.js
# tests 198
# pass 196
# fail 2
not ok 7 - test/daily-cap.test.js
not ok 11 - test/provenance.test.js
```
**Zero delta**: the same two pre-existing reds (`daily-cap.test.js`, `provenance.test.js`), unmodified by this round and not silently fixed. +15 tests, all new, all passing. 0 regressions.

**Secret guard.**
```
$ git diff --cached --name-only
fn/src/functions/api.js
fn/src/lib/boilerplate-filter.js
fn/src/lib/rollup-engine.js
fn/src/lib/taxonomy.js
fn/test/api-views.test.js
fn/test/rollup-boilerplate-boards.test.js
fn/test/rollup-competitor-alias.test.js
fn/test/rollup-feature-split.test.js
fn/test/rollup-topic-tags.test.js
swa/index.html
```
No `.env`, `local.settings.json`, `fn/local.settings.json`, `agent-host/agent-host.env`, or any `*.env` file staged.

**SCHEMA_VERSION unchanged.**
```
fn/src/lib/taxonomy.js:66:const SCHEMA_VERSION = 3; // v1 base · v2 strategy dims · v3 tool sentiment + embeddings
```
Line number and value both unchanged from base.

**reanalyze.js / aoai.js untouched.**
```
$ git diff --stat fn/src/functions/reanalyze.js fn/src/lib/aoai.js
(empty — no output, no changes)
```
`/api/reanalyze` is never called or referenced anywhere in this diff (grepped the full diff for `reanalyze` and `ANALYSIS_SCHEMA`; the only match is the unrelated `SCHEMA_VERSION` re-export line in `taxonomy.js`'s `module.exports`, value unchanged).

## 9. Deviations from the brief (summary)

1. Branched from `origin/main` HEAD (`cb97152...`) rather than the stale `f0ea25fc...` cited in the brief — code-identical for every file touched (§1).
2. The "behavioural" acceptance checks (§4.6.1-4.6.4) were verified against fixtures shaped exactly like the brief's own cited production examples, not the live corpus — this environment has no Azure Table Storage credentials, no `local.settings.json`, and no `loop-admin` (§2). Production verification remains the founder's post-deploy step per §7.
3. `boilerplate-filter.js`'s `isBoilerplateText` takes `(registry, sub, text)` rather than the brief's literal `(sub, text)` — the registry is passed explicitly so the function is a pure, independently-unit-testable helper rather than closing over hidden module state. `makeExcluder(registry)` also exposes `isBoilerplateText(sub, text)` bound to that registry, satisfying the brief's literal two-function surface as well.
4. §4.4(c)'s bounded audit found one additional in-scope fix beyond the heat map (`distributions.topicTotals`) — included per the brief's own instruction to fix any consumer that is "both unscoped and feed[s] a user-facing topic count" (§5 above).

## 10. STOP conditions

None triggered for the engineering work itself — all applicable checks pass, no test regressed, no forbidden file was touched, scope was not exceeded. The one open item is the environment's inability to run the live-corpus behavioural checks (§2), which is a tooling/access limitation rather than a defect in this round's code, and is explicitly not silently assumed to pass.
