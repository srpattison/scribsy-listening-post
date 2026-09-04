# CB-LISTEN-ACCEPT-RESTAMP-1 — restamped acceptance receipt for CB-LISTEN-CORRECT-1

| # | Check (verbatim, CORRECT-1 §7) | Verdict | Evidence (file:line / test name) | Defect (if not LANDED) |
|---|---|---|---|---|
| 1 | Provenance stamps written on every new analysis; all five fields; versions resolved from one module. | LANDED | `fn/src/lib/aoai.js:227-232` (stamp built at call site), `fn/src/lib/analyze-worker.js:139-146` (registry/filter versions folded in), `fn/src/lib/store.js:176-179` (`PROVENANCE_COLUMNS`), all versions derived via `fn/src/lib/analysis-provenance.js` | — |
| 2 | Test proving `analysisInputHash` changes when the assembled input changes and is stable when it does not. | LANDED | `fn/test/provenance.test.js` — `"§7.2: analysisInputHash is stable when the assembled input does not change"` and `"§7.2: analysisInputHash changes when the assembled input changes — body, and comment set alike"`, both exercised against the real call site (`analyzePost`), not re-derived | — |
| 3 | Unstamped-row count exposed in health and observed to be rowsAnalyzed before any new analysis runs. | LANDED | `fn/src/lib/analysis-provenance.js:192-204` (`provenanceHealthBlock`, REPO-3-guarded), `fn/src/lib/store.js:259-273` (`countPosts` computes the tally from live Table rows), wired at `fn/src/functions/api.js:65,119` | — |
| 4 | Classification-gates-analysis audit completed; inverted if present, explicitly reported NOT NEEDED if absent. | LANDED | Recorded in commit `6c2387a` message, Item 2: "classification-gates-analysis audit: NOT NEEDED. No enqueueAnalysis call site consults a classifier verdict...". Code-verified: no `enqueueAnalysis` call site (`ingest.js:37`, `backfill.js:41,56`, `reanalyze.js:44`, `analyze-worker.js:106`) references `content-class`/`contentClass`. | — |
| 5 | Backfill self-heal sweep implemented, idempotent, logged, threshold named. | LANDED | `fn/src/lib/backfill-sweep.js` (sweep + `BACKFILL_SWEEP_STALE_HOURS_DEFAULT`), wired into daily ingest at `fn/src/functions/ingest.js:159-166`, threshold resolved at `fn/src/lib/config.js:151-155`; idempotency + logging covered by `fn/test/backfill-sweep.test.js` (4 tests, see §5 below) | — |
| 6 | Negative control on the sweep: a sub at `exhausted: true` must NOT be re-enqueued. Test it. | LANDED | `fn/test/backfill-sweep.test.js` — `"§7.6 NEGATIVE CONTROL: a walk at exhausted: true is NOT re-enqueued, however stale its row"`; fixture sets `updatedAt` 400 days stale (would trigger re-enqueue on every other predicate), proving the control can fire | — |
| 7 | maxTrackedHashes configurable and raised; hashCapHit still reported. | PARTIAL | Configurable + raised: `deploy.sh:89,237`, `fn/src/lib/config.js:165-169`. Still reported: `fn/src/lib/audit.js:72,462,508,523-525`. | Brief-asserted defect ("the truncation path reads the wrong identifier [DAILY_ANALYZE_CAP] instead of AUDIT_MAX_TRACKED_HASHES") was searched for and **not found** in `fn/src/` at either `b4de107` or `f0ea25f`. See §7 below for the full search and an alternate, unconfirmed hypothesis. |
| 8 | Health additions present, no existing field removed or renamed. | LANDED | `git diff 6c2387a~1 b4de107 -- fn/src/functions/api.js` (quoted in §8) — only `provenance` and `backfillOrphans` added to `health()`'s return object; no existing key touched. Re-checked `b4de107..f0ea25f`: only `deployedSha` (ping) and `modelVersions` (provenance tally) added. | — |
| 9 | Offline tests pass. Do not run a live sweep against production storage. | LANDED | `node --test test/*.test.js` at `f0ea25f`: 201/201 pass, 0 fail. At `b4de107`: 200/200 pass, 0 fail. Zero delta (no regressions; +1 test from CORRECT-2). No live sweep run; no production storage called. | — |
| 10 | Receipt opens with a per-item LANDED / PARTIAL / NOT BUILT table. | LANDED | This file — this table is the first content after the title. | — |

---

## Header

- Round: CB-LISTEN-ACCEPT-RESTAMP-1
- Repo: srpattison/scribsy-listening-post
- SHAs read: `b4de1079497abcba78bb02d501c3181e4f3f60fc` (CORRECT-1 landed), `f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c` (main, deployed)
- Date: 2026-09-04
- STEP ZERO: see below — positive proof obtained by actually pushing a branch, not by a permissions-API read alone (the API read was misleading; see below).

## STEP ZERO — write access

First check, `gh api repos/srpattison/scribsy-listening-post --jq '{full_name: .full_name, permissions: .permissions}'`, returned:

```
{"full_name":"srpattison/scribsy-listening-post","permissions":{"admin":false,"maintain":false,"pull":false,"push":false,"triage":false}}
```

`push: false`. Taken alone this would read as the CB-N8N-SYNC-2 failure shape (session bound to zero write access). It is not: the `permissions` field on `GET /repos/{owner}/{repo}` reflects collaborator affiliation for the authenticating actor and is not populated meaningfully for the GitHub App installation token this session's git remote actually uses (`x-access-token` embedded in `git remote -v`, separate from whatever principal `gh api` resolved). Rather than trust either reading, positive proof was obtained directly:

```
$ git checkout -b feat/CB-LISTEN-ACCEPT-RESTAMP-1 main
Switched to a new branch 'feat/CB-LISTEN-ACCEPT-RESTAMP-1'

$ git push -u origin feat/CB-LISTEN-ACCEPT-RESTAMP-1
remote:
remote: Create a pull request for 'feat/CB-LISTEN-ACCEPT-RESTAMP-1' on GitHub by visiting:
remote:      https://github.com/srpattison/scribsy-listening-post/pull/new/feat/CB-LISTEN-ACCEPT-RESTAMP-1
remote:
To https://github.com/srpattison/scribsy-listening-post.git
 * [new branch]      feat/CB-LISTEN-ACCEPT-RESTAMP-1 -> feat/CB-LISTEN-ACCEPT-RESTAMP-1
branch 'feat/CB-LISTEN-ACCEPT-RESTAMP-1' set up to track 'origin/feat/CB-LISTEN-ACCEPT-RESTAMP-1'.
```

The branch push succeeded. That is positive proof of write access, not absence of an error on a permissions probe. `git fetch origin` and `git ls-remote --heads origin` also both succeeded, confirming both read and write access to `srpattison/scribsy-listening-post` before any further work began.

## 1. Provenance stamps (LANDED)

Read at `b4de107` (unchanged at `f0ea25f` — CORRECT-2 did not touch `aoai.js` or `analyze-worker.js`, confirmed by its commit stat below).

`fn/src/lib/aoai.js:224-233`:
```js
  const _provenance = {
    analysisInputHash: provenance.hashAnalysisInput(ANALYSIS_SYSTEM, user),
    analysisPromptVersion: analysisPromptVersion(),
    analysisAt: new Date().toISOString(),
    analysisModel: deploymentInForce()
  };
```
`analysisPromptVersion()` (`aoai.js:189-195`) calls `provenance.promptVersionFrom(...)` — the one derivation module. `analyze-worker.js:139-146` folds in the two remaining fields at the worker, both also from `analysis-provenance.js`:
```js
  const callSiteStamp = analysis._provenance || null;
  ...
  stamp = {
      ...callSiteStamp,
      analysisRegistryVersion: provenance.registryVersionOf(boilerplateHashes),
      analysisFilterVersion: provenance.filterVersion()
  };
```
All five semantic fields (input hash, prompt version, registry version, filter version, timestamp) plus the review-added sixth (`analysisModel`) resolve from the single module `fn/src/lib/analysis-provenance.js`. `store.js:176-179` pins the column set (`PROVENANCE_COLUMNS`) consumed by both the write path and the `countPosts` health tally, so a renamed column breaks both together rather than drifting apart.

Live corroboration (founder-measured, cited not re-derived): `stampedAnalyzedRows` 1,383 == `rowsAnalyzed` delta (101,550 − 100,167).

## 2. Input-hash discrimination test (LANDED)

```
$ node --test test/provenance.test.js
```
Relevant subtests (full run: 16/16 pass):
```
# Subtest: §7.2: analysisInputHash is stable when the assembled input does not change
ok 5 - §7.2: analysisInputHash is stable when the assembled input does not change
# Subtest: §7.2: analysisInputHash changes when the assembled input changes — body, and comment set alike
ok 6 - §7.2: analysisInputHash changes when the assembled input changes — body, and comment set alike
# Subtest: the input hash matches the EXACT strings the chat client received — computed at the call site, not re-derived
ok 7 - the input hash matches the EXACT strings the chat client received — computed at the call site, not re-derived
```
Read adversarially: the "changes" test calls the real `analyzePost` three times with `POST`, `{...POST, selftext: 'a different body entirely'}`, and `POST` plus an added comment, and asserts the resulting `_provenance.analysisInputHash` values are pairwise distinct — it varies the input **at the call site**, not by mutating stored fields. A separate test (`ok 7`) asserts the hash equals `provenance.hashAnalysisInput(system, user)` computed from the strings a spy actually captured mid-flight, proving the hash is computed from what was sent, not re-derived after the fact. This clears the round's own bar ("does it vary the input at the call site, or does it re-derive the hash from stored fields?").

## 3. Unstamped-row count in health (LANDED)

`fn/src/lib/store.js:259-273` — `countPosts()` builds the tally from a live Table scan (`postsTable().listEntities(...)`), not a constant:
```js
async function countPosts() {
  let total = 0, analyzed = 0, posts = 0, comments = 0;
  const tally = provenanceLib.createProvenanceTally();
  ...
  for await (const e of iter) {
    total++;
    if (e.analyzed === true) { analyzed++; tally.add(e); }
    ...
  }
  return { total, analyzed, unanalyzed: total - analyzed, posts, comments, provenance: tally.result() };
}
```
REPO-3 trap check: `fn/src/functions/api.js:65` wraps the call — `store.countPosts().catch((e) => ({ error: e.message }))` — and `analysis-provenance.js:192-198` (`provenanceHealthBlock`) explicitly checks `if (!counts || counts.error) return { unavailable: true, ... }` before ever reading `unstampedAnalyzedRows`. This is exercised by `fn/test/provenance.test.js`:
```
# Subtest: REPO-3: a failed row scan surfaces as UNAVAILABLE in the health block, never as the zero that means "fully stamped"
ok 16 - REPO-3: a failed row scan surfaces as UNAVAILABLE in the health block, never as the zero that means "fully stamped"
```
The 100,167 baseline is historical (not re-derived here); live corroboration (founder-measured, cited): `stampedAnalyzedRows` 1,383.

## 4. Classification-gates-analysis audit (LANDED)

The audit's own record, commit `6c2387a` message, Item 2:
```
Item 2 — classification-gates-analysis audit: NOT NEEDED. No enqueueAnalysis
call site consults a classifier verdict and the analyze worker never reads
contentClass; classification already gates COUNTING only (rollup-engine
humanRows/nonHumanRows split). Reported, not invented.
```
Code half, verified independently at `f0ea25f`:
```
$ grep -n "enqueueAnalysis" fn/src/functions/*.js fn/src/lib/*.js
src/functions/reanalyze.js:44:      await store.enqueueAnalysis({
src/functions/backfill.js:41:  await store.enqueueAnalysis({
src/functions/backfill.js:56:  await store.enqueueAnalysis({
src/functions/ingest.js:37:    await store.enqueueAnalysis({ subreddit: post.subreddit, id: post.id, created_utc: post.created_utc });
src/lib/analyze-worker.js:106:    await storeImpl.enqueueAnalysis(job, 6 * 3600);
```
```
$ grep -rln "content-class|contentClass" fn/src/
src/lib/store.js
src/lib/config.js
src/lib/content-class.js
src/lib/retag.js
src/lib/rollup-engine.js
src/lib/audit.js
src/lib/boilerplate-registry.js
src/lib/comment-filter.js
src/lib/analysis-provenance.js
```
None of the five `enqueueAnalysis` call sites appear in the `contentClass`-referencing file list; `rollup-engine.js` (counting/aggregation, not gating) does. Both halves — the recorded outcome and the code claim it records — are present and consistent: LANDED.

## 5. Backfill self-heal sweep (LANDED)

`fn/src/lib/backfill-sweep.js` defines `sweepOrphanedBackfills` and `BACKFILL_SWEEP_STALE_HOURS_DEFAULT = 24`. Wired into the daily schedule at `fn/src/functions/ingest.js:159-162`:
```js
    counters.backfillSweep = await backfillSweep.sweepOrphanedBackfills({
      ...
      staleHours: config.backfillSweepStaleHours()
```
Threshold resolution, `fn/src/lib/config.js:151-155`, env-overridable, defaulting to the named constant — not a literal. `deploy.sh:85,236` (`DEFAULT_BACKFILL_SWEEP_STALE_HOURS='24'`, `resolve "BACKFILL_SWEEP_STALE_HOURS" ...`) is the config-side half.

Four separate properties, four separate test verdicts:
```
$ node --test test/backfill-sweep.test.js
ok 1 - §7.5: an orphaned walk (queued, unexhausted, stale) is re-enqueued as a resume, with the re-enqueue logged and recorded
ok 2 - §7.6 NEGATIVE CONTROL: a walk at exhausted: true is NOT re-enqueued, however stale its row
ok 3 - idempotency (live chain): fresh updatedAt means a chain is running — no second message may be enqueued over it
ok 4 - idempotency (double sweep): a second sweep inside the threshold window skips the sub it just re-enqueued
...
1..11
# pass 11
# fail 0
```
- exists: `ok 1`
- idempotent (no duplicate over a live/just-swept chain): `ok 3`, `ok 4`
- logs every re-enqueue: asserted inline in `ok 1` (`context.warned.some(m => m.includes('re-enqueued orphaned posts walk for r/AO3'))`)
- threshold named constant with env override: `ok 9` (`"the staleness threshold is a named constant with an env override, not a literal buried in a condition"`)

## 6. Negative control on the sweep (LANDED)

```
# Subtest: §7.6 NEGATIVE CONTROL: a walk at exhausted: true is NOT re-enqueued, however stale its row
ok 2 - §7.6 NEGATIVE CONTROL: a walk at exhausted: true is NOT re-enqueued, however stale its row
```
Fixture, `fn/test/backfill-sweep.test.js`:
```js
test('§7.6 NEGATIVE CONTROL: a walk at exhausted: true is NOT re-enqueued, however stale its row', async () => {
  const store = fakeStore({
    statuses: {
      writing: { queued: true, exhausted: true, months: 12, watermark: 1786000000, updatedAt: iso(NOW - 400 * 24 * HOUR) }
    }
  });
  ...
  assert.deepStrictEqual(store.enqueued, [], 'a finished walk must never be woken — 19 of 23 subs sit in exactly this state');
```
The fixture sets `updatedAt` 400 days stale — every predicate the sweep checks *except* `exhausted` would fire a re-enqueue on this row. That the row is nonetheless skipped proves the control can actually reach and exercise the `exhausted === true` guard (`backfill-sweep.js`, the `if (status.exhausted === true) { summary.skipped.exhausted++; continue; }` line) — not a fixture that trivially never reaches the branch it claims to guard.

## 7. maxTrackedHashes configurable and raised; hashCapHit still reported (PARTIAL)

Configurable and raised — confirmed:
```
$ grep -n "AUDIT_MAX_TRACKED_HASHES\|DAILY_ANALYZE_CAP" deploy.sh
72:DEFAULT_DAILY_ANALYZE_CAP='20000'   # as-built live value 2026-08-16
89:DEFAULT_AUDIT_MAX_TRACKED_HASHES='250000'
229:resolve "DAILY_ANALYZE_CAP"      "${DAILY_ANALYZE_CAP:-}"      "$DEFAULT_DAILY_ANALYZE_CAP"
237:resolve "AUDIT_MAX_TRACKED_HASHES"   "${AUDIT_MAX_TRACKED_HASHES:-}"   "$DEFAULT_AUDIT_MAX_TRACKED_HASHES"
```
`fn/src/lib/config.js:165-169`:
```js
const DEFAULT_AUDIT_MAX_TRACKED_HASHES = 250000;
function auditMaxTrackedHashes(env = process.env) {
  const n = parseInt(env.AUDIT_MAX_TRACKED_HASHES || String(DEFAULT_AUDIT_MAX_TRACKED_HASHES), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_AUDIT_MAX_TRACKED_HASHES;
}
```
Still reported — confirmed: `fn/src/lib/audit.js:72` (`const maxTrackedHashes = () => config.auditMaxTrackedHashes();`), consumed at `audit.js:462` (`mergeChunk`) and `audit.js:508` (`duplicateSummary`), surfaced at `audit.js:523-525` (`hashCapHit`, `trackedHashCount`, `maxTrackedHashes` all in the returned summary).

**The brief-asserted defect was not located.** §2 of BRIEF.md states as fact: "the truncation path reads the wrong identifier" — implying a line in the audit code reads `DAILY_ANALYZE_CAP` (or its value 20,000) where it should read `AUDIT_MAX_TRACKED_HASHES`, and directs this round to "find the line ... and quote it with its file and line number." The following was searched and none of it shows the claimed defect:
```
$ grep -rn "DAILY_ANALYZE_CAP|dailyAnalyzeCap|20000|20,000" fn/src
```
returned only: `daily-cap.js` (a documented, unrelated §8n concurrency-cap defect, not this one), `config.js:158,176-181` (comment + the real `dailyAnalyzeCap()` function, which nothing in the hash-tracking path calls), `audit.js:65-66` (a comment *describing* the historical 20,000 saturation, not a live reference), `analyze-worker.js:8,46` (the daily spend cap — a different subsystem entirely). `mergeChunk` and `duplicateSummary` (quoted above) both default `hashCap` from `maxTrackedHashes()` → `config.auditMaxTrackedHashes()` → `AUDIT_MAX_TRACKED_HASHES`, and `audit-worker.js:84,88` calls both with no override, so the correct identifier is what actually executes in this codebase at both `b4de107` and `f0ea25f`.

Per this round's own verification discipline ("prefer the weaker claim ... never assert what a grep finding nothing cannot support"), this round does **not** assert the code is defect-free — only that the *specific* defect BRIEF.md names could not be found in `fn/src/`, searched as shown above. An alternate, **unconfirmed** hypothesis, offered because the round's own instructions require naming where a defect lives rather than leaving it unlocated: `deploy.sh`'s `resolve()` (`deploy.sh:188-199`) writes the *default* only when no environment override AND no existing **live** Azure app-setting value is found for that name (`live=$(live_get "$name"); if [ -n "$live" ]... PRESERVED_SETTINGS+=...; return 0`); if `AUDIT_MAX_TRACKED_HASHES` already existed on the live Function App as `20000` from an earlier partial rollout, a later `deploy.sh` run with the code shown above would **preserve** that live 20,000 rather than promote it to the new 250,000 default. That would be a live Azure app-settings state fact, not a code defect — and confirming or refuting it requires reading live Azure app settings, which is out of scope for this read-only round (§2, §9 of BRIEF.md forbid a live call). This is flagged in "what is owed next" below rather than asserted as fact.

Verdict recorded as PARTIAL per the round's own instruction (§5 row 7 of BRIEF.md), on the strength of the confirmed configurable/reported halves — but the defect attribution in BRIEF.md §2 is a claim this round could not corroborate and should not be repeated as settled fact by a future reader of this table.

## 8. Health additions only, no removal/rename (LANDED)

```
$ git diff 6c2387a~1 b4de107 -- fn/src/functions/api.js
```
(full diff shown; the `health()` return object hunk:)
```diff
   audit: auditReport && !auditReport.error ? auditReport : null,
+    // Provenance-stamp coverage ...
+    provenance: provenance.provenanceHealthBlock(counts, { currentVersions: currentAnalysisVersions() }),
+    backfillOrphans,
    checkedAt: new Date().toISOString()
```
Every pre-existing key in the returned object (`rowsTotal` … `audit`) is untouched; only `provenance` and `backfillOrphans` are new. Re-checked `b4de107..f0ea25f` (CORRECT-2) the same way:
```
$ git diff b4de107 f0ea25f -- fn/src/functions/api.js
```
adds `deployedSha` to the `ping` handler and `modelVersions` to the provenance tally's `result()` (`fn/src/lib/analysis-provenance.js`) — again additive only, no removal or rename at either commit.

## 9. Offline tests pass (LANDED)

Dependencies were not installed in this checkout (no `node_modules`, and per `.gitignore`'s own comment the repo deliberately carries no lockfile); `npm install` was run in `fn/` to obtain an accurate offline baseline — no source file was changed by this step.

At `f0ea25f` (main):
```
$ node --test test/*.test.js
...
1..201
# tests 201
# suites 0
# pass 201
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
At `b4de107` (isolated `git worktree`, same `npm install`):
```
$ node --test test/*.test.js
...
1..200
# tests 200
# suites 0
# pass 200
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
Baseline: 201 pass / 0 fail at main, 200 pass / 0 fail at `b4de107` — the one extra test is CORRECT-2's `modelVersions` regression test, not a new failure. Zero delta vs main, as required. No live sweep was run; no production storage was called at any point in this round.

## 10. Receipt opens with a per-item table (LANDED)

This file. The ten-row table is the first content in this document, before any prose.

---

## What is NOT verified by this round

This round reads code at two fixed commits and runs the offline test suite; it does not observe production behaviour. The founder-measured figures cited in checks 1, 3, and 7 (`rowsTotal`, `rowsAnalyzed`, `stampedAnalyzedRows`, `trackedHashCount`, `hashCapHit`, `lastRollupAt`, `audit.duplicates.hashCapHit`) are cited testimony from BRIEF.md §2, not this round's own measurement — this round did not and was not permitted to call production storage or `/api/insights` live. Whether the live Azure Function App is actually running code at `f0ea25f` (as BRIEF.md §1 asserts from an `/api/ping` read) is likewise cited, not re-checked here. Whether `AUDIT_MAX_TRACKED_HASHES` is actually set to `20000` or `250000` (or unset) on the live Function App — which would resolve check 7's open question — is not observable from this round and was not read.

## What is owed next, and whose hands it is in

1. **Check 7's defect location.** BRIEF.md asserts a specific code-level defect (wrong identifier in a truncation path) that this round searched for and could not find in `fn/src/`. Before this is treated as settled, someone with live Azure read access should check the current value of the `AUDIT_MAX_TRACKED_HASHES` app setting on the deployed Function App directly (e.g. `az functionapp config appsettings list`) — if it reads `20000`, the `deploy.sh` `resolve()`-preserves-a-stale-live-value mechanism described in §7 above is the likely mechanism, and the fix (if any) is either a one-time `az functionapp config appsettings set AUDIT_MAX_TRACKED_HASHES=250000` or a `deploy.sh` change to force the new default past a preserved stale value on this one setting. This is a live-config/possible-deploy-script question, not a change to `fn/src/`, and it is a future round's work, in founder or lane-CODE-with-live-access hands — not fixed here, per this round's read-only mandate.
2. Nothing else in the ten checks is outstanding; checks 1–6 and 8–10 are LANDED with no open thread.

## Secret guard

```
$ git diff --cached --name-only
```
(run immediately before commit, see below) — no `.env`, `*.env`, `fn/local.settings.json`, function key, or `AOAI_KEY` value is staged; the only staged path is this report file itself.

## Branch / PR

Branch: `feat/CB-LISTEN-ACCEPT-RESTAMP-1`, cut from `main` at `f0ea25f`. PR contains exactly one added file: this report.
