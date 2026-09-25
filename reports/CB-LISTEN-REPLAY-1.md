# CB-LISTEN-REPLAY-1 — bounded ID-list replay

**Round:** CB-LISTEN-REPLAY-1 (makes the ~40-record metered replay possible; does not run it)
**Branch:** `feat/CB-LISTEN-REPLAY-1`, cut from `main` at `092916f3efeac262e7426de227abd456de62856a`
**Status:** draft PR. Not merged, not deployed. No model or API calls were made.

## Phase 0 — read-only findings

All references are to the baseline SHA `092916f3`.

- **`main` HEAD:** `092916f3efeac262e7426de227abd456de62856a` ("CB-LISTEN-FIX-1 … (#12)"). Matches the brief; stop-check does not apply.
- **`quality-pilot.js` loads rows only through the frozen pilot:** `fn/scripts/quality-pilot.js:39` calls `frozenPilotRows(archive)`, which throws unless there are exactly 1,000 `pilotRows` and 1,000 `pilotIds` whose `digest(ids.join('\n'))` equals `manifest.pilot.selectionHash` (`fn/src/lib/frozen-pilot.js:5-8`). It then runs **16 workers** over every pending row (`quality-pilot.js:90-91`). Resume checks the archive's pilot hash (`quality-pilot.js:46`) and reads `--resume` only as the fourth positional argument (`quality-pilot.js:36`).
- **`quality-pilot.js` loads config at import:** its top-level `require('../src/lib/analysis-pipeline')` (`quality-pilot.js:7`) pulls in `./config` (`fn/src/lib/analysis-pipeline.js:11`). The pipeline require was moved into `replayRow` so a rejected ID list fails before any config module loads (T2).
- **`quality-benchmark.js`:** `digest` = SHA-256 hex (`fn/src/lib/quality-benchmark.js:9`); `identity(row)` = `` `${partitionKey}|${rowKey}` `` (`quality-benchmark.js:10`); `checkQuotes` classifies each stored quote against the post and context comments as `single-origin` / `multiple-origins` / `filtered-source-only` / `not-verified` / `short-ambiguous` (`quality-benchmark.js:54-78`). It locates a quote among units; it does not test the speaker slot.
- **`private-fixture-check.js`:** fixture file names at `fn/scripts/private-fixture-check.js:23-28`; refuse-inside-repo rule in `resolvePrivateDir` (`:45-55`); starter read and hash-gated at `:144-151`; the judged subset is taken from `report.json.reviews[].id` matched against `report.json.queue[i].id` **by packet position** (`:186-193`); the pilot archive is read at `:197-198`.

### Membership stop-check (private, counts only)

| | count |
|---|---:|
| Starter cases | 3 |
| Starter cases resolved to a pilot row | 3 |
| Distinct `reviews[].id` in the report | 37 |
| Starter cases that are also judged records | 3 |
| **Derived IDs (deduplicated)** | **37** |
| Resolved in `archive.pilotRows` via `identity` | 37 |
| **Unresolved** | **0** |

No ID is unresolved, so the round continues past Phase 0.

**ID-format finding.**
- The judged IDs are already `partitionKey|rowKey`, in two row-key shapes: 23 short Reddit base-36 keys and 14 colon-delimited keys. All 37 resolve directly with `identity`. No mapping was needed.
- The starter cases carry **no ID**, only a masked `caseKey` (`LP-NNN`) and the masked source.
  - The blind packet is **shuffled relative to the report queue**: only 2 of 236 checkable packet positions have the same post title as the queue entry at that position.
  - So `caseKey` is not a queue position, and neither is the packet index.
  - Each starter case was therefore resolved by its post title (trimmed, case-folded). Each title matches exactly one of the 1,000 pilot rows.
  - For the one starter case whose raw record is in the archive, the post body also matches exactly.
  - `replay-ids.js` refuses to write the list if any starter title matches zero rows or more than one.
- **The replay set is 37 records, not ~40**, because all 3 starter cases are among the 37 judged records.

**Pre-existing defect noticed, not fixed here (out of scope):** `private-fixture-check.js:186-193` selects its `judged` corpus by assuming packet position equals queue position. Given the shuffle above, the FIX-1 `judged` counts were computed on largely the wrong cases. The `starter` and `packet` corpora are unaffected. Flagged for a separate round.

## Phase 1 — tests (`fn/test/listen-replay-1.test.js`)

The tests use synthetic data only. Model, store, cap and blob are injected stubs.

- **T1.** ID mode replays only the listed rows. A 1,000-row archive with a 3-ID list gives exactly 3 `analyzePost` calls.
- **T2.** A list longer than the ceiling is rejected. The cases: 51 IDs; 3 IDs with `--max-rows=2`; `--max-rows=60`. Each throws before the runtime loader is called and before any model or reserve call, and creates no output directory. A fresh child process confirms that none of `store`, `aoai`, `config`, `daily-cap`, `analysis-pipeline` or `boilerplate-filter` is in `require.cache` after the rejection.
- **T3.** An ID missing from `pilotRows` throws before any spend. An archive with no `pilotRows` is the same refusal. Neither falls back to the full pilot.
- **T4.** With no ID list, a 999-row archive still fails `Frozen pilot manifest mismatch`. A valid 1,000-row archive replays all 1,000 rows with the archive's `selectionHash`. `--max-rows` without `--ids` is rejected.
- **T5.** A cap-stopped ID-mode run checkpoints `selectionHash = digest(ids.join('\n'))`. Resume is rejected for a shorter list, a reordered list, and a frozen-mode resume. Resume with the same list replays only the 2 remaining rows. The original `<archive> <settings> <out> --resume` form still parses.
- **T6.** The setup is a synthetic `pilot.private.json` produced by the pilot itself. It contains distinctive post, comment, error and username text, one skipped AutoModerator submission and one errored row. `replay-summary.js`, run as a child process:
  - prints none of that text, no `partitionKey|rowKey` identity and no quote;
  - prints only integers, and keys and values that pass a name pattern;
  - gives the expected counts.
- **replay-ids.** Starter cases come first, then report order, deduplicated. Ambiguous or unmatched titles are counted as unresolved.

### Baseline vs HEAD

The suite was run with no model, API or storage key set. A `--require` preload makes any `net.Socket.connect` or `fetch` fail and log. Child processes inherit the preload.

| Run | tests | pass | fail | network attempts |
|---|---:|---:|---:|---:|
| `092916f3` full suite | 284 | 282 | 2 | 0 |
| `092916f3` + `listen-replay-1.test.js` only | 7 | 0 | **7** | 0 |
| HEAD full suite | 291 | 290 | 1 | 0 |

- **Formerly failing, now passing:** "the repo contains exactly one subreddit list, in deploy.sh". It failed on baseline because `reports/CB-LISTEN-BOARDS-2.md` quotes the list. `reports` is now skipped; that report is unedited.
- **Pre-existing failure, unchanged:** "§8n: 200 interleaved CAS increments land exactly 200, not fewer" (`fn/test/daily-cap.test.js:56`). It fails 3 of 3 runs on baseline on this Windows host, and fails the same way on HEAD. This round does not touch it.
- **Delta:** 7 new tests, all pass. One fixed test. No other change.

**Mutation checks.** Each mutation was applied to HEAD `quality-pilot.js`, the targeted test was run, and the file was restored.

| Mutation | Test | Result |
|---|---|---|
| ID list ignored, full pilot used | T1, T3 | ✖ |
| Ceiling raised to 1,000 | T2 | ✖ |
| Missing IDs silently filtered | T3 | ✖ |
| ID-mode `selectionHash` set to the archive's pilot hash | T5 | ✖ |
| `analysis-pipeline` required at top level again | T2 (child-process probe) | ✖ |

**Representative passing trial (T1).**
- Archive: 1,000 synthetic rows. ID list: `examplewriters|p900`, `examplewriters|p5`, `examplewriters|p321`.
- Stub `analyzePost` calls = **3 of 1,000 rows**; stub `reserve` calls = 3.
- Summary: `{ mode: 'ids', selected: 3, processed: 3 }`.
- Snapshot: result IDs equal the listed set, `mode: 'ids'`, `idCount: 3`, `productionAnalysisWrites: 0`.

### Private dry checks (counts only, zero model calls)

- `replay-ids.js` against the private fixtures reported: 3 starter cases, 3 resolved, 37 judged, 37 derived, 37 resolved, 0 unresolved. It wrote `out/replay-ids.json` (37 entries) inside the private directory. Pointed at a directory inside the repo, it refused (exit 2).
- `selectRows` over the real archive with that list returned 37 rows in `mode: 'ids'`, without loading `store`, `aoai`, `config` or `daily-cap`.

## Phase 2 — changes

- **`fn/scripts/quality-pilot.js`**
  - Parses `--ids=<path>`, `--max-rows=<n>` and `--resume` explicitly. The positional arguments stay first.
  - The ID file must resolve outside the repo, using the same guard as the output directory. It must be a non-empty, duplicate-free array of `partitionKey|rowKey`.
  - Hard ceiling `ID_CEILING = 50`. `--max-rows` may only lower it.
  - Rows are selected from `archive.pilotRows` in list order. Workers = `min(16, pending rows)`.
  - The snapshot records `mode`, `idCount` and the ID-list `selectionHash`. A resume must match hash, mode and membership.
  - The store, model, cap and config wiring moved into `loadRuntime()`, which is injectable. It runs only after selection and resume checks pass.
  - Unchanged: `replayRow` (shared `excludeUnits` / `groundOutput`), `reserveDailySlot` against the existing cap, the five-consecutive-errors stop, `productionAnalysisWrites: 0`, and the private blob `lp-quality/<out basename>`.
- **`fn/scripts/replay-ids.js`** (new). Reads only from `$LP_PRIVATE_DIR` using `private-fixture-check`'s `resolvePrivateDir`. Writes `$LP_PRIVATE_DIR/out/replay-ids.json` (starter first, then report order, deduplicated). Prints counts only. Refuses to write if anything is unresolved or the list exceeds the ceiling.
- **`fn/scripts/replay-summary.js`** (new). Takes a `pilot.private.json` path outside the repo and prints counts only:
  - rows: results, compared, skipped by reason, errored, stopped;
  - quote status by field, old vs new, from `oldChecks` / `newChecks`, with `excludedSourceOnly` (mod/bot-sourced) and `quoteNotFound` broken out;
  - `grounding.drops` by field;
  - `stance_on_ai` old→new transitions, and `comment_stance_mix` totals old vs new;
  - `ai_related` transitions;
  - rows with every list field empty, old vs new;
  - `feature_requests` count old vs new, and new by `basis`;
  - `changedFields` frequency;
  - `usage`.

  Every label passes an allowlist, and anything else counts as `other`. A parse failure prints a fixed line, because JSON errors echo input.
- **`fn/test/config.test.js`:** `'reports'` added to the skip set, with a comment.
- **`README.md`:** a short ID-mode note.
- **`fn/test/listen-replay-1.test.js`** (new).

No other shared module was touched.

## Acceptance checks

1. **Baseline behaviour:** T1–T6 fail on `092916f3` (7/7 fail) and pass on HEAD. The passing trial is recorded above.
2. **Existing suite:** zero delta apart from the new tests and the fixed subreddit-list test. The one other failure (CAS §8n) is pre-existing.
3. **Syntax:** `node --check` passes on all 5 changed JS files.
4. **Zero model calls:** the full suite ran with keys unset and network blocked, with 0 attempts logged.
5. **Secret guard:** see the commit-time check below.
6. **Public-data guard:** `fn/scripts/public-data-guard.js` was run once against the private fixtures with the change staged. `git ls-files` shows no `*.private.json` and no `replay-ids.json`. This report cites counts only.
7. **Paths:** only the files listed under Phase 2, plus this report.

## Founder Cloud Shell invocation (placeholders only; NOT run)

This needs its own explicit go. It makes about 37 model calls against the existing daily cap.

```bash
cd ~/scribsy-listening-post && git checkout main && git pull && cd fn && npm ci
export LP_PRIVATE_DIR="$HOME/<lp-private>"
node scripts/replay-ids.js
node scripts/quality-pilot.js "$LP_PRIVATE_DIR/2026-09-18-e372b521b6ecaaee.json" "<settings.json>" "$LP_PRIVATE_DIR/replay-<YYYYMMDD>" --ids="$LP_PRIVATE_DIR/out/replay-ids.json"
node scripts/replay-summary.js "$LP_PRIVATE_DIR/replay-<YYYYMMDD>/pilot.private.json"
```

To resume after a cap stop, repeat the `quality-pilot.js` line with the same `--ids` and add `--resume`. Use `$LP_PRIVATE_DIR`/`$HOME` rather than `~` after `--ids=`, because the shell does not expand `~` there.

## What is NOT done

- The replay has not been run. No model or API call, deploy, merge, cap change, reanalysis, rubric edit or production write was made.
- The live analyze path, `analysis-pipeline.js`, the prompt, schema and validator are unchanged.
- The `private-fixture-check.js` positional `judged` selection defect above is flagged, not fixed.
- The CAS §8n test failure on this host is not investigated.
