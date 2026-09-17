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
