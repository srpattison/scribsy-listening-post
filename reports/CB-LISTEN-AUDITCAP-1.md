# CB-LISTEN-AUDITCAP-1 — audit hash-cap investigation (read-only, T2)

Source of truth: `srpattison/scribsy-listening-post` @ `f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c` (the commit the brief names as "deployed"). All file:line references and `git show`/`git log` quotes below are read at that exact SHA unless a commit hash is given explicitly for historical context. No live call to production storage was made by the runner — every live command in §5 below is handed to the founder, unexecuted.

**Runner note on the brief's own base pointer.** This repo, as checked out, was a *shallow* clone (`.git/shallow` present, `main` truncated to one commit). `f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c` was therefore initially unreachable (`git merge-base --is-ancestor … main` → exit 1, "NOT ANCESTOR"). `git fetch --unshallow origin` retrieved full history; after that, `git merge-base --is-ancestor f0ea25fc… main` → exit 0 ("IS ANCESTOR"), and `git show f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c --stat` resolves to the exact commit the brief describes (`Merge pull request #1 from srpattison/feat/CB-LISTEN-CORRECT-2`). This is recorded because an unreachable SHA in a shallow clone is itself a "wrong vantage point" failure mode (§6b.10) worth naming, not silently working around.

## Findings table

| Question | Finding | Status | Evidence |
|---|---|---|---|
| §4.1(1) accumulator write | `audit-worker.js:121` → `store.saveBlobJson(ACCUMULATOR_NAME, acc)` → `store.js:490` writes blob `${name}.json` in container `audit-state` | CONFIRMED | fn/src/lib/audit-worker.js:121, fn/src/lib/store.js:34,484,490 |
| §4.1(1) blob name is `${name}.json`, not `${name}` | Confirmed literally — `getBlockBlobClient(\`${name}.json\`)` | CONFIRMED | fn/src/lib/store.js:490 |
| §4.1(2) accumulator read | `loadAccumulator` → `getBlobJson(ACCUMULATOR_NAME)`; null on 404; `__corrupt` branch present | CONFIRMED | fn/src/lib/audit-worker.js:40-51, fn/src/lib/store.js:500-512 |
| §4.1(3) report write side | `persistReport(storeImpl,'audit',report,{context})` → `store.saveAggregate('audit','latest'|<date>, report)` — recon's inference, checked | CONFIRMED (was inference, is now measured) | fn/src/lib/audit-worker.js:121, fn/src/lib/retag.js:29-35 |
| §4.1(4) report read side | `store.getAggregate('audit','latest')` in `health()` | CONFIRMED | fn/src/functions/api.js:78,114 |
| §4.1(5) which store, which container | Accumulator = blob, container `audit-state`. Report = Table Storage entity, table `aggregates` (a different table from — not a different container than — a hypothetical Table location; there is no second blob container involved on the report side at all) | CONFIRMED | fn/src/lib/store.js:16,34,353 |
| §4.1 extra: can `duplicates` be dropped by shrinkToFit | Yes, in principle — no field is exempt — but dropping produces an **absent** `duplicates` key, not a stale-valued one, so it cannot be the mechanism behind a *specific* `trackedHashCount:20000` reading | CONFIRMED (mechanism), REFINED (does not explain the observed reading) | fn/src/lib/tablesafe.js:33-70 |
| §4.2(1) fossil report row from the *original* hardcoded 20000, pre-CORRECT-1 | LIVE candidate, now backed by history: `audit.js` shipped 2026‑08‑16 with `const MAX_TRACKED_HASHES = 20000` (hardcoded, not env-configurable) and was not made configurable until CORRECT‑1 landed 2026‑08‑26. A full pass that exhausted in that 10-day window would persist exactly `trackedHashCount:20000, hashCapHit:true` forever (worker is dormant post-exhaustion) | LIVE (repo-consistent; needs §5(1) to confirm) | commit ce45209 (2026-08-16T16:15:43-04:00), commit 97a298a (2026-08-16T19:59:16-04:00), commit 6c2387a (2026-08-26T17:56:08Z) |
| §4.2(2) sticky accumulator surviving under a different name/container | REFUTED for the current name/container (founder found `audit-state` empty); a *prior* storage form existed before the r2 fix — a Table Storage row `aggregates` partition `audit-accumulator`, row `latest` — but no code path reads that location anymore | REFUTED (current path); UNTESTABLE-FROM-REPO (whether the old Table row still physically exists) | commit 97a298a diff (see §4.2 detail below) |
| §4.2(3) hardcoded 20000 outside fn/src | None found in `deploy.sh`, `swa/`, `.github/` other than the already-refuted `DEFAULT_DAILY_ANALYZE_CAP` | REFUTED (search closed, see grep below) | grep output below |
| §4.2(4) chunk-count arithmetic (20000 = 10×2000 = 4×5000) | REFUTED — `hashIfEligible` only hashes bodies ≥120 chars (`DUP_MIN_CHARS`), so N chunks yield strictly fewer than 2000N *hashes seen*, and `trackedHashCount` counts **distinct** hashes, which is ≤ hashes seen | REFUTED | fn/src/lib/content-class.js:38, fn/src/lib/audit.js (DUP_MIN_CHARS = cc.DEFAULT_MIN_CHARS) |
| §4.2(5) Table query page/continuation cap | REFUTED — no `maxPageSize`/`.top(` anywhere in the audit read path | REFUTED | grep output below (empty) |
| §4.2(6) new path found this round | The *literal origin* of "20000" for this exact field is `audit.js`'s own original `MAX_TRACKED_HASHES = 20000` constant (pre-CORRECT-1) — not a coincidence with `DAILY_ANALYZE_CAP` at all for this candidate. This sharpens §4.2(1) from "plausible" to "the cap value is attested in this repo's own history at exactly 20000" | CONFIRMED (historical fact); still NEEDS-LIVE-READ to confirm it explains the *current* row | commit ce45209:fn/src/lib/audit.js:52,372 |
| §4.3 discriminator | See table below — not yet read live | NEEDS-LIVE-READ | §5(1) |
| §9 dashboard (`swa/index.html`) | Does not reference `duplicates`, `audit`, `hashCapHit`, `trackedHashCount`, or `maxTrackedHashes` anywhere. `renderHealthBar` only reads `h.lastRollupSectionsFailed`, `h.rowsUnanalyzed`, `h.rowsTotal`, `h.lastRollupAt`. The founder's reading was not computed or cached by the dashboard — it came from the raw API JSON, consistent with the brief's expectation | CONFIRMED | swa/index.html:399-406 (grep of full file for the audit/duplicates terms returned zero matches) |
| Recon accuracy check: "Repo root at f0ea25fc is exactly: .github, .gitignore, LICENSE, README.md, deploy.sh, fn, reports, swa" | Not accurate — `git ls-tree f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c --name-only` returns `.github, .gitignore, LICENSE, README.md, deploy.sh, fn, swa` — **no `reports/` directory exists at this SHA**. `reports/` is not created in this repo's history until commit `e1b176b` (CB-LISTEN-ACCEPT-RESTAMP-1), which post-dates f0ea25fc. This round is what first creates `reports/CB-LISTEN-AUDITCAP-1.md`. Recon's §4.2(3) "closed and small" search-surface claim (no `scripts/`) is still correct — that part of the listing was right, only the inclusion of `reports` was wrong. | REFUTED (recon's root-listing claim) | `git ls-tree f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c --name-only` |
| Recon accuracy check: "DEFAULT_DAILY_ANALYZE_CAP sits two lines above DEFAULT_AUDIT_MAX_TRACKED_HASHES" | Not accurate as stated — they are 17 lines apart (lines 72 and 89), with three other `DEFAULT_*` declarations between them (`BOILERPLATE_MIN_REPEATS`, `BOILERPLATE_MIN_CHARS_BODY`, `BOILERPLATE_MIN_CHARS_TITLE`, `BACKFILL_SWEEP_STALE_HOURS`). The coincidence itself (two *different* caps, one of them literally 20000) is still correct and attribution #1 stays dead — only the "two lines" proximity claim is wrong | REFUTED (proximity claim only); attribution #1 itself remains REFUTED | deploy.sh:72,89 (quoted below) |

## §4.3 — computed at rollup time, or live? (the decisive table, cheapest next measurement)

| `maxTrackedHashes` reads | What it means |
|---|---|
| `20000` | The whole `duplicates` object is a fossil written before the cap was raised (either before CORRECT‑1's config change, or before a live app-setting override took effect). No code defect exists; the worker simply hasn't run since. |
| `250000` | The row was rewritten after the cap was raised, by a run that loaded a pre-existing accumulator carrying sticky `hashCapHit: true` / `trackedHashCount: 20000`. That would contradict the founder's empty-container reading of `audit-state` — meaning either the container was emptied *after* that run, or the accumulator lives somewhere §4.2(2) has not found (residual: the old Table-based location, see below — though nothing in the current code reads it, so it could not have *produced* a post-rewrite row either). |

This field (`audit.duplicates.maxTrackedHashes`) was already present in the JSON the founder read on 2026-09-04 13:02Z and was not reported. Command (1) in §5 answers it directly. Given the repo evidence in the findings table (§4.2(1)/(6) — the cap really was hardcoded to exactly 20000 for a 10-day production window, 2026‑08‑16 to 2026‑08‑26, before CORRECT‑1 made it configurable), the repo-consistent expectation is the first branch — but this is a prediction from repo history, not a substitute for reading the row.

## §4.1 — trace duplicateSummary's input state, five legs

**Leg 1 — write side of the accumulator.**
```
fn/src/lib/audit-worker.js:121:  await persistReport(storeImpl, 'audit', report, { context });
```
That's the report; the accumulator write is the line just above it in the same function:
```
fn/src/lib/audit-worker.js:97:  await storeImpl.saveBlobJson(ACCUMULATOR_NAME, acc);
```
`ACCUMULATOR_NAME = 'audit-accumulator'` (fn/src/lib/audit-worker.js:29). `store.saveBlobJson`:
```
fn/src/lib/store.js:484: async function saveBlobJson(name, value) {
fn/src/lib/store.js:486:   const container = blobSvc.getContainerClient(AUDIT_STATE_CONTAINER);
fn/src/lib/store.js:490:   await container.getBlockBlobClient(`${name}.json`).upload(body, Buffer.byteLength(body), {
```
Confirmed: the blob name really is `${name}.json` → `audit-accumulator.json`, not `${name}` bare. `AUDIT_STATE_CONTAINER = 'audit-state'` at fn/src/lib/store.js:34.

**Leg 2 — read side of the accumulator.**
```
fn/src/lib/audit-worker.js:40: async function loadAccumulator(storeImpl, context) {
fn/src/lib/audit-worker.js:41:   const raw = await storeImpl.getBlobJson(ACCUMULATOR_NAME);
fn/src/lib/audit-worker.js:42:   if (raw == null) return null; // never written yet — a genuinely fresh start, not a recovery
fn/src/lib/audit-worker.js:43:   if (raw.__corrupt) {
fn/src/lib/audit-worker.js:48:     audit.validateAccumulator(raw);
```
`store.getBlobJson`'s null-on-404 branch:
```
fn/src/lib/store.js:500: async function getBlobJson(name) {
fn/src/lib/store.js:509:     if (e.statusCode === 404) return null;
```
Both the null-on-404 and the `__corrupt` (unparseable-JSON) branch are confirmed present exactly as recon described.

**Leg 3 — write side of the REPORT (recon did not read this; it was an inference).**
```
fn/src/lib/retag.js:29: async function persistReport(store, name, report, { now = () => new Date(), context } = {}) {
fn/src/lib/retag.js:30:   const stamp = now().toISOString().slice(0, 10);
fn/src/lib/retag.js:31:   for (const rowKey of ['latest', stamp]) {
fn/src/lib/retag.js:33:     await store.saveAggregate(name, rowKey, report);
```
Called from audit-worker.js:121 as `persistReport(storeImpl, 'audit', report, { context })`. This resolves to `store.saveAggregate('audit', 'latest', report)` **and** `store.saveAggregate('audit', '<YYYY-MM-DD>', report)` — two writes per chunk, both `Replace` mode (fn/src/lib/store.js:353-365, mode `'Replace'`). **Recon's inference is CONFIRMED, not refuted** — `persistReport` really does write `metric='audit', period='latest'` to the `aggregates` table, exactly matching what `api.js health()` reads.

**Leg 4 — read side of the report.**
```
fn/src/functions/api.js:78:  store.getAggregate('audit', 'latest').catch((e) => ({ error: e.message })),
fn/src/functions/api.js:114:  audit: auditReport && !auditReport.error ? auditReport : null,
```
Re-confirmed at f0ea25fc — identical to §3.1's quote.

**Leg 5 — which store, which container, in one sentence each.**
- The accumulator is a **blob** in Blob Storage, container `audit-state` (fn/src/lib/store.js:34), named `audit-accumulator.json`.
- The report is a **Table Storage entity** in the `aggregates` table (fn/src/lib/store.js:16, `AGG_TABLE = 'aggregates'`), partition `audit`, row `latest` (and a second dated row).
- These are two structurally different storage primitives (Blob vs. Table), not two containers of the same kind — recon's framing is correct, restated precisely: there is no "other container" on the report side to check, because the report was never in Blob Storage at all.

**shrinkToFit / can `duplicates` be dropped?**
```
fn/src/lib/tablesafe.js:33: function shrinkToFit(payload, maxChars = MAX_TOTAL_CHARS) {
fn/src/lib/tablesafe.js:59:   const out = { ...payload };
fn/src/lib/tablesafe.js:63:   while (JSON.stringify(out).length > budget) {
fn/src/lib/tablesafe.js:64:     const keys = Object.keys(out).filter((k) => k !== '_truncated');
fn/src/lib/tablesafe.js:66:     const fattest = keys.sort((a, b) => sizeOf(b) - sizeOf(a))[0];
fn/src/lib/tablesafe.js:67:     delete out[fattest];
fn/src/lib/tablesafe.js:68:     dropped.push(fattest);
```
The drop order is **size-descending over all top-level keys, with no exemption list** — `duplicates` is exactly as eligible for eviction as `quoteProvenance`, `authorConcentration`, `fiction`, etc. So: **yes**, `duplicates` can in principle be dropped by `shrinkToFit`. But `unpackJson` (fn/src/lib/tablesafe.js, `unpackJson`) only ever reconstructs whatever keys survived in `json`/`json1`.../`jsonN` — a dropped field is **entirely absent** from the reassembled object, it does not fall back to a stale previous value (each `saveAggregate` call is mode `'Replace'`, fn/src/lib/store.js:353-365, so there is no previous-value carryover to begin with). Therefore: **truncation could make `audit.duplicates` disappear from a health read, but it cannot make it read a stale `20000`/`true` while itself being present** — the founder's actual observation (`audit.duplicates.trackedHashCount == 20000` present and readable) is inconsistent with this mechanism as an explanation. Recorded as a refinement of the brief's §4.1 framing, not a new confirmed path. If a future health read shows `audit.duplicates` **missing** (not stale), that is this mechanism, and the property prefix to check is `json`/`json1`.../`jsonN` on `aggregates`/`audit`/`latest` plus the entity's own `truncated` column (comma-joined dropped-field names, fn/src/lib/store.js:360).

## §4.2 — every code path that can yield trackedHashCount==20000 with cap 250000

1. **Fossil report row, LIVE candidate — strengthened.** `audit.js` shipped 2026-08-16T16:15:43-04:00 (commit `ce45209`) with:
   ```
   ce45209:fn/src/lib/audit.js:52:  const MAX_TRACKED_HASHES = 20000;
   ce45209:fn/src/lib/audit.js:372:      if (next.trackedHashCount >= MAX_TRACKED_HASHES) { next.hashCapHit = true; continue; }
   ```
   hardcoded, not env-configurable. The same-day r2 fix (commit `97a298a`, 2026-08-16T19:59:16-04:00, "stop the accumulator from being silently truncated") moved the accumulator to Blob Storage but **left the cap hardcoded at 20000** (`97a298a:fn/src/lib/audit.js:64: const MAX_TRACKED_HASHES = 20000;`). The cap did not become configurable until commit `6c2387a` (CB-LISTEN-CORRECT-1, 2026-08-26T17:56:08Z), which introduced `config.auditMaxTrackedHashes()` defaulting to 250000. **So there was a real ~10-day production window (2026-08-16 to 2026-08-26) during which a fully-exhausted audit pass would legitimately, correctly, non-buggily persist `trackedHashCount: 20000, hashCapHit: true, exhausted: true` to `aggregates/audit/latest`.** Since the worker only self-requeues while capped and does nothing once exhausted (fn/src/functions/audit.js:37-39), and nothing has re-triggered it since (§3.4, unchanged at this SHA), that row would sit unchanged today. This is the strongest form of recon's leading candidate — not just "a fossil is plausible" but "the exact value 20000 is attested as this system's own real historical cap, in this repo's own history." Status: **LIVE** (repo-consistent hypothesis; §5(1) is the decisive read).

2. **Sticky accumulator surviving under a different name/container.** REFUTED at the current name/container: founder listed `audit-state` empty (attribution #3) and the current code only ever reads `audit-state/audit-accumulator.json` (leg 1/2 above). Extending recon's check per the brief's instruction to look for a rename: `git log --all -p -- fn/src/lib/audit-worker.js fn/src/lib/store.js` shows the accumulator's **prior** storage form, before commit `97a298a`:
   ```
   ce45209:fn/src/lib/audit-worker.js:34:  const prevAcc = await storeImpl.getAggregate('audit-accumulator', 'latest');
   ce45209:fn/src/lib/audit-worker.js:45:  await storeImpl.saveAggregate('audit-accumulator', 'latest', acc);
   ```
   i.e. before the r2 fix, the accumulator lived as a **Table Storage row**, `aggregates` table, partition `audit-accumulator`, row `latest` — not a blob at all, and not in `audit-state`. No rename of `ACCUMULATOR_NAME` or `AUDIT_STATE_CONTAINER` themselves was ever committed (both strings are unchanged since their introduction in `97a298a`); what changed was the *storage medium* wholesale. This old Table row, if it still physically exists, is **not read by any code at this SHA** (`loadAccumulator` only calls `getBlobJson`), so it cannot be *producing* the current health reading regardless of its contents. Status: **REFUTED** (current path); **UNTESTABLE-FROM-REPO** (whether the pre-r2 Table row `aggregates`/`audit-accumulator`/`latest` still exists as an orphan — worth a founder check for cleanup, not because it can explain the symptom).

3. **Hardcoded 20000 outside fn/src.** Full-repo search, `.github/`, `swa/`, `deploy.sh`, at `f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c`:
   ```
   $ git grep -n "20000" f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c -- deploy.sh swa .github
   f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c:deploy.sh:72:DEFAULT_DAILY_ANALYZE_CAP='20000'   # as-built live value 2026-08-16
   f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c:deploy.sh:86:# CB-LISTEN-CORRECT-1: audit duplicate-hash ceiling. The old hard-coded 20000

   $ git grep -n "AUDIT_MAX_TRACKED_HASHES\|audit-accumulator\|audit-state\|ACCUMULATOR_NAME\|AUDIT_STATE_CONTAINER" f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c -- .github swa
   (no output — zero matches)
   ```
   `git ls-tree -r --name-only f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c -- .github swa` confirms the full surface: `.github/workflows/claude-brief.yml`, `swa/index.html`. No `scripts/` directory exists at this SHA (root listing: `.github, .gitignore, LICENSE, README.md, deploy.sh, fn, swa` — see the findings-table row above noting recon's inclusion of `reports/` in this listing was inaccurate). No hardcoded 20000 found in `swa/`, `deploy.sh`, or `.github/` other than the already-refuted `DEFAULT_DAILY_ANALYZE_CAP` and a comment referencing the old value, by the two commands above. (Weaker claim, per §6.2 — this is what the command found, not a claim that no such literal exists anywhere never checked.) Status: **REFUTED**.

4. **Chunking arithmetic coincidence (20000 = 10×2000 = 4×5000).** `chunkSize` defaults to 2000 (`fn/src/lib/audit-worker.js:63: const chunkSize = job.chunkSize || 2000;`) and is clamped to `[1, 5000]` by `fn/src/functions/audit.js:49` (`const chunkSize = Math.min(Math.max(parseInt(p.get('chunkSize') || '2000', 10) || 2000, 1), 5000);`). But `trackedHashCount` counts **distinct hashes**, not rows or chunks: `cc.hashIfEligible` only hashes a post body when it is ≥ `DUP_MIN_CHARS` (`fn/src/lib/audit.js:58: const DUP_MIN_CHARS = cc.DEFAULT_MIN_CHARS;` = 120 chars, `fn/src/lib/content-class.js:38`). So per chunk, the number of `hashHits` pushed is ≤ rows read, and the number of *distinct new* hashes added to `trackedHashCount` is ≤ that. A chunk of 2000 rows yields strictly fewer than 2000 tracked-hash increments (some rows are too short, some rows are comments not posts and are skipped entirely — `fn/src/lib/audit.js:305: if (kindOf(r) !== 'post' || !r.createdUtc) continue;`, some hashes repeat and increment `.count` on an existing entry rather than `trackedHashCount`). There is no code path where N chunks deterministically yield exactly `2000N` or `5000N` distinct hashes. Status: **REFUTED**.

5. **Table query page/continuation cap.** `listRowsForAudit` (fn/src/lib/store.js:315) and `listAnalyzedPosts` (fn/src/lib/store.js:245) both use `for await (const e of table.listEntities({ queryOptions: {...} }))` with no `maxPageSize` and no `.top(...)`. Confirmed by grep:
   ```
   $ git grep -n "maxPageSize\|\.top(" f0ea25fc2a55a12cc3196de7ed71bc84d4c0722c -- fn/src/lib/store.js fn/src/lib/audit.js fn/src/lib/audit-worker.js fn/src/functions/audit.js
   (no output — zero matches)
   ```
   The SDK's `listEntities` auto-pages via continuation tokens; nothing in the audit read path imposes a fixed page count. Status: **REFUTED**.

6. **New path found this round — see row 6 of the findings table above and item 1 of this list.** The most useful addition is not a sixth independent mechanism but a sharpening of mechanism 1: this repo's own commit history shows `MAX_TRACKED_HASHES = 20000` was a real, hardcoded, shipped value for ten days, which converts "a fossil row is plausible" into "the fossil row's exact value is attested as this system's own historical constant." No further path (a sixth *distinct* mechanism) was found; §4.2(1)/(6) together are assessed as the most probable explanation, pending §5(1).

## Three refuted attributions — restated, still dead

| # | Attribution | Status | Confirmed by this round |
|---|---|---|---|
| 1 | "the truncation path reads DAILY_ANALYZE_CAP" | REFUTED (unchanged) | `config.auditMaxTrackedHashes()` is the sole cap resolver (fn/src/lib/audit.js:72, fn/src/lib/config.js:167); no reference to `DAILY_ANALYZE_CAP` or `dailyAnalyzeCap()` exists anywhere in fn/src/lib/audit.js, fn/src/lib/audit-worker.js, or fn/src/functions/audit.js. `DEFAULT_DAILY_ANALYZE_CAP='20000'` and `DEFAULT_AUDIT_MAX_TRACKED_HASHES='250000'` are two adjacent-*ish* but unrelated defaults in deploy.sh — **correction to recon**: they sit at lines 72 and 89 (17 lines apart, with `BOILERPLATE_MIN_REPEATS`/`BOILERPLATE_MIN_CHARS_BODY`/`BOILERPLATE_MIN_CHARS_TITLE`/`BACKFILL_SWEEP_STALE_HOURS` defaults in between), not "two lines apart" as recon stated. The coincidence-of-value claim (one of the two is literally 20000) is correct and the attribution stays dead; only the proximity description was inaccurate. Quoted: `deploy.sh:72:DEFAULT_DAILY_ANALYZE_CAP='20000'   # as-built live value 2026-08-16` / `deploy.sh:89:DEFAULT_AUDIT_MAX_TRACKED_HASHES='250000'`. |
| 2 | "deploy.sh resolve() preserved a stale live 20000" | REFUTED (unchanged, live-measured by founder 22:2xZ, not re-tested here per binding rule §6.5) | Not re-derived; recon's founder-measured live appsettings read (`AUDIT_MAX_TRACKED_HASHES = 250000`) stands. This round adds repo context only: `resolve()`'s precedence (env → live → shipped default, `deploy.sh` "resolve NAME ENV_VALUE DEFAULT" block) means a live value of 250000 would only be overwritten back to a stale default if the live setting were ever unset — no evidence of that in the repo. |
| 3 | "stale persisted summary in the audit-state blob container" | REFUTED IN BLOB FORM (unchanged) — and this round's §4.2(2) finds the specific place the inversion points to: the accumulator's *prior* (pre-r2, pre-2026-08-16 20:00) storage form was a Table Storage row, not a blob, so the founder's blob-container check was necessarily blind to that historical location too — though, as established, nothing reads that old location anymore, so it is inert, not a live culprit. | fn/src/lib/store.js (current), commit 97a298a diff (historical) |

## §4.4 — what cannot be known without a live read

Unchanged from recon, confirmed still true from the repo alone:
- the current contents of `aggregates/audit/latest` — including `maxTrackedHashes`, `updatedAt`, `finishedAt`, `exhausted`, and `truncated`
- whether `audit-state/audit-accumulator.json` exists under that exact name
- the depth of the `audit-jobs` queue (is a chunk mid-flight?)
- when `AUDIT_MAX_TRACKED_HASHES` was last changed on the live app

Added by this round, also unanswerable from the repo:
- whether the **pre-r2** Table Storage row `aggregates`/`audit-accumulator`/`latest` (§4.2(2)) still physically exists as an orphan (harmless either way, since nothing reads it, but worth a founder check for hygiene)

## §5 — founder Cloud Shell commands (NOT executed by the runner)

`--auth-mode login` lacks the RBAC on this account; every command below uses the connection string.

```bash
# Resource names from deploy.sh: ST=scribsylisten2026, RG=scribsy-listening
STCONN=$(az storage account show-connection-string -n scribsylisten2026 -g scribsy-listening -o tsv)

# (1) THE DECISIVE ONE — the row api.js health() actually reads.
# Answers §4.3: read maxTrackedHashes, updatedAt, finishedAt, exhausted, truncated.
# NOTE (this round): saveAggregate packs the payload through tablesafe.packJson,
# which chunks large JSON across `json`, `json1`, `json2`, ... properties (up to
# `json11`, MAX_CHUNKS=12) and reassembles them on read. A raw `entity show` will
# return those chunk properties directly, NOT a single readable `duplicates` key —
# read `json`+`json1`+... concatenated and JSON.parse it, or use a client that
# calls store.getAggregate/unpackJson for you. The entity's own `truncated`
# column (comma-joined field names) tells you if any top-level field — including
# `duplicates` — was dropped entirely by shrinkToFit (fn/src/lib/tablesafe.js:33-70).
az storage entity show --table-name aggregates \
  --partition-key audit --row-key latest \
  --connection-string "$STCONN" -o json

# (2) Does the accumulator blob exist under its exact name?
# Answers §4.2(2). The container listing alone is not this check.
az storage blob exists -c audit-state -n audit-accumulator.json \
  --connection-string "$STCONN" -o json
az storage blob list -c audit-state --connection-string "$STCONN" -o table

# (2b) NEW this round — check the pre-r2 storage location too, for hygiene only
# (nothing in the current code reads this; it cannot explain the current
# health() reading either way, per §4.2(2)).
az storage entity show --table-name aggregates \
  --partition-key audit-accumulator --row-key latest \
  --connection-string "$STCONN" -o json

# (3) Is a chunk mid-flight, or is the worker genuinely dormant? (§3.4)
az storage queue stats --name audit-jobs --connection-string "$STCONN" -o json 2>/dev/null || \
  az storage message peek --queue-name audit-jobs --num-messages 5 --connection-string "$STCONN" -o json

# (4) When was the cap last changed on the live app?
az functionapp config appsettings list -n scribsy-listen-fn-2026 -g scribsy-listening \
  --query "[?name=='AUDIT_MAX_TRACKED_HASHES']" -o json
```

## What a T1 fix round would have to do (not designed, not built — informational only)

Agreeing with recon: raising the cap alone cannot repair the number. If §4.2(1)/(6) is confirmed live (the row is a fossil from the 2026-08-16–08-26 hardcoded-20000 window), then:
- Hashes dropped during the original capped pass (the 230k+ rows never scanned, or scanned but whose hashes were never tracked once the 20000 ceiling was hit) are not recoverable by resuming — `mergeChunk`'s cursor-based resume (fn/src/lib/audit-worker.js:73, `acc.cursor`) picks up *after* where the accumulator stopped, and a `hashCapHit`-poisoned accumulator's `cursor` reflects wherever the pass happened to be sitting when the cap first saturated, not a clean slate.
- A re-run against an **exhausted** accumulator (`exhausted: true` already reported, worker dormant per §3.4) contributes zero new `hashHits`, because nothing re-enqueues it — `POST /api/audit` would have to be called explicitly, and even then `runAuditChunk` loads whatever accumulator is currently persisted (fn/src/lib/audit-worker.js:71, `loadAccumulator`), which — if it is the same sticky, capped one — would immediately report `hashCapHit: true` again on any further merge, at whatever `trackedHashCount` it was frozen at (unless deleted/reset first, see `validateAccumulator`'s rejection of malformed state, fn/src/lib/audit.js).
- Implication: a correct T1 fix likely requires (a) raising/confirming the live `AUDIT_MAX_TRACKED_HASHES` app setting (already reportedly 250000 per attribution #2), **and** (b) deleting or resetting the persisted accumulator blob (`audit-state/audit-accumulator.json`) so `loadAccumulator` returns null and the next `POST /api/audit` starts a genuinely fresh, full-corpus pass — not merely resuming a capped one — **and** (c) accepting the cost of a full re-pass over the entire corpus (all ~190k+ real rows, one bounded blob-read chunk at a time, self-requeuing), since there is no cheaper way to recover hashes that were never tracked the first time. This agrees with recon's framing; this round adds the (b) accumulator-deletion requirement as an explicit, code-grounded step (not just "re-run"), since a resume without deletion would not actually restart from zero.

## Mechanical acceptance

1. Exactly one file added: `reports/CB-LISTEN-AUDITCAP-1.md`. (See `git show --stat` in REPORT.md for the commit this round produces.)
2. Secret guard: no `.env`, `local.settings.json`, `fn/local.settings.json`, or `*.env` staged (see `git diff --cached --name-only` in REPORT.md).
3. No source file modified: `git diff --name-only main...HEAD` lists only `reports/CB-LISTEN-AUDITCAP-1.md` (see REPORT.md).
4. No live storage call was made by the runner. Confirmed explicitly: every `az storage`/`az functionapp` command in this document is quoted for the founder to run manually; none was executed in this session. The only commands executed by the runner were local, read-only `git` operations (`git show`, `git log`, `git grep`, `git ls-tree`, `git merge-base`, `git fetch`) against the already-cloned repository — no network call to Azure, and no `curl`/`az` invocation of any kind.
