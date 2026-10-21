---
requirement: "tôi muốn phải có thêm smoke test or là real test ở đâu đó thể hiện và có thể có 1 cái report đã test gì, or là regression test" — smoke runs on QC
started: 2026-10-21
workspace: Main
status: converged
---

# Discovery — Each run ends with a test report: suite, AC coverage, regression scope and a smoke test on QC

Goal 2 of 4 (Butter, 2026-10-21). Thread: CONV-1792553864229-255. Mockup (Test report tab): https://claude.ai/artifact/JZKYzy8jaPDW4821EmZD3o

## Round 1

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | thread opened, no messages yet | [conversation CONV-1792553864229-255] |
| user | the ask; smoke runs on QC | chat 2026-10-21 |
| skill | a QC build is a workflow dispatch `gh workflow run ci-api.yaml --ref <branch> -f BUILD_IMAGE_QC_V1=YES`; QC rolls out from CI (C5 `deployment.apps/<svc> restarted`); the ref can be any branch, so the run branch could reach QC before merge | ~/.claude/skills/ichiba-deploy/SKILL.md Phase C (C1, C5) |
| record | the last QC verification of bpa-engine was done by hand: Chrome on test-seller, `fetch` to `https://test-api.ichiba.net/bpa/tung-nike-store/...` with the session cookie, creating throwaway types named `zz_test_2542_*` | C:/dev/insfrastrucure/ichiba/docs/deploys/2026-10-20-bpa-engine-qc-task2543-2544.md:16-41 |
| map | QC DB of bpa-engine is 10.29.70.110 and was migrated by a guarded script; QC Rancher is reachable without PAM | vault/10-Projects/ichiba-devops/prod-investigation-map.md:76,108 |
| tool | `feature_projection(role=tester)` returns `regressionScope` = the titles of the feature's shipped tasks (5 for journey-lead-to-delivered), without the tests that guard them | tool call 2026-10-21 |
| goal 3 | AC coverage states (covered / weak / open / human) come from goal 3's `acs` | docs/reports/task-sequence-and-test-cases-discovery.md (Contract settled) |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | Butter's words; today a QC check is a hand-run Chrome session whose only record is a deploy file | — |
| 2 | Scope & boundary | 5 | QC exists for Ichiba services only; choda-deck / companion / JM have no QC | D4 |
| 3 | Technical contract | 5 | dispatch, QC host and API shape known; auth for an unattended smoke unknown | D2 |
| 4 | Prior art | 8 | ichiba-deploy C/E phases, the 2026-10-20 QC record, tester projection | — |
| 5 | Edges & failure | 4 | QC down, CI runner disk full (2026-10-16), test data left behind, smoke before merge vs after | D1, D3 |
| 6 | NFR | 4 | security of a QC credential; writes on a shared QC | D2, D3 |
| 7 | Acceptance criteria | 2 | none | blocked |

**TOTAL = MIN = 2**. New evidence: YES (6).

### Score history
| # | Dimension | R1 |
|---|---|---|
| 1 | Problem & value | 9 |
| 2 | Scope & boundary | 5 |
| 3 | Technical contract | 5 |
| 4 | Prior art | 8 |
| 5 | Edges & failure | 4 |
| 6 | NFR | 4 |
| 7 | Acceptance criteria | 2 |
| | **MIN** | **2** |

### Stop — blocked on human decisions
D1 when the QC smoke runs · D2 how it authenticates · D3 whether it may write test data on QC · D4 what the report says for projects with no QC.

## Round 2

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | no human messages in the thread | [conversation CONV-1792553864229-255] |
| user | D1 before merge, from the run branch: after the PRs open, one question, then build-qc from the run branch, QC migration if any (asked first), smoke, results into the PR and the report; Butter merges after a green smoke · D2 the logged-in test-seller Chrome tab through Claude in Chrome, no new credential · D3 writes allowed, names `zz_test_<task>_<id>` in the test workspace, ids recorded, nothing else touched · D4 a project with no QC runs the smoke locally against the real app and says env = local | AskUserQuestion answers, 2026-10-21 |
| repo | QC builds exist for bpa-engine (`ci-api.yaml`), remote-bpa (`ci-seller.yaml`), headless-cms (`ci-api.yaml`), remote-headless-cms; workflow-engine, NewJuvenisMaxime and JuvenisMaxime.AI have none | `.github/workflows/*` grep for BUILD_IMAGE_QC / build-qc, 2026-10-21 |
| code | bpa-engine does not migrate on start-up (no `Migrate` in Program.cs), so a QC smoke after a schema change needs the migration run first | C:/dev/test/bpa-engine/src/BpaEngine/Program.cs grep |
| record | QC is one shared environment (test-seller / test-api); a branch build replaces what everyone on QC sees until the next build | deploys/2026-10-20-bpa-engine-qc-task2543-2544.md:5-6 ("Rollback (QC): re-dispatch build-qc from master") |

### Contract settled
- **Smoke spec, written at planning time** in the goal body as `## Smoke`: `env: qc | local`, `base:` (QC: `https://test-api.ichiba.net/bpa/<workspace>`; local: start command + base URL), and a table `| # | check | call | expect |`. /choda-plan writes it; a goal that changes no runtime surface writes `Smoke: n/a — <reason>`.
- **/choda-autopilot §6.0, after the PRs open:**
  1. one 🟡 decision notice "deploy run branch to QC for smoke?" naming that QC is shared and will run the branch until master is rebuilt;
  2. on yes: dispatch build-qc from the run branch per repo, wait for C3–C5 (job success, image pushed, `restarted`); a CI failure → 🔴, smoke not run;
  3. migrations in the run → a Waiting-on-you item with the full SQL (goal 4's Open/Copy), the loop waits for Butter's "done" on the decide screen;
  4. needs a logged-in test-seller tab; none → 🟡 "open test-seller and log in", smoke waits, not failed;
  5. runs each check through Claude in Chrome `fetch(..., {credentials:'include'})`, records got vs expect, the ids of `zz_test_*` data;
  6. local env: start the app with the spec's command, run the checks with plain HTTP, stop it;
  7. writes the report, comments the smoke table on each PR, and the 🟢 notice says `smoke: N/M passed (qc|local)`.
- **Report file**: `<goal home cwd>/docs/reports/<goal-id>-test-report.md`, committed on the run branch as one `test(report): …` commit (not an item). YAML frontmatter, read by the adapter:
  `suite {passed, skipped, failed} | null` (from each item's fixed `full suite:` line, goal 3/TASK-2561), `testsAdded`, `ac {covered, weak, open, human, total}` (goal 3's rule), `smoke {env, base, build, ranAt, passed, failed, checks: [{name, call, expect, got, ok}], data: [ids]} | {na: reason} | null`, `regression: [{task, title}]` (feature tester projection, goal 1's feature).
- **`GET /runs`**: each run gains `report: { path, summary } | null` — `summary` is the frontmatter; `null` when the file is not in the goal home workspace.
- **Companion**: the Test report tab of the mockup (tiles, smoke table, regression list, Open full report with Copy).

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | carried | — |
| 2 | Scope & boundary | 9 | D1-D4; out: prod smoke, load/perf tests, automatic cleanup of `zz_test_*` when no delete API exists, a QC for repos without one | — |
| 3 | Technical contract | 9 | above; dispatch command and checks (ichiba-deploy C1-C5), QC host and cookie auth (2026-10-20 record), migration rule (Program.cs) | — |
| 4 | Prior art | 9 | ichiba-deploy phases C/E, the 2026-10-20 QC verification, tester projection, goal 3's AC rule | — |
| 5 | Edges & failure | 9 | CI fails (runner disk, 2026-10-16) → 🔴 not run; no logged-in tab → 🟡 waits; migration needed → waits for Butter; shared QC → asked first and named; repo without QC → local; smoke fails → PR comment + red tile, never auto-merged; re-run → new `ranAt`, old data ids kept | — |
| 6 | NFR | 9 | security: no new credential, cookie never stored or logged; data: only `zz_test_*` writes; availability: QC shared — deploy asked first; observability: report + PR comment + notice; perf: smoke ≤ ~10 calls | — |
| 7 | Acceptance criteria | 9 | drafts for the plan: report frontmatter shape, `/runs report` null vs present, tiles from frontmatter, autopilot notice texts, `Smoke: n/a` handling | — |

**TOTAL = MIN = 9**. Previous 2 → 9. New evidence: YES (5).

### Score history
| # | Dimension | R1 | R2 |
|---|---|---|---|
| 1 | Problem & value | 9 | 9 |
| 2 | Scope & boundary | 5 | 9 |
| 3 | Technical contract | 5 | 9 |
| 4 | Prior art | 8 | 9 |
| 5 | Edges & failure | 4 | 9 |
| 6 | NFR | 4 | 9 |
| 7 | Acceptance criteria | 2 | 9 |
| | **MIN** | **2** | **9** |

## All dimensions ≥ 9 after 2 rounds

| # | Dimension | WHY it earned 9 |
|---|---|---|
| 3 | Contract | every step reuses a path already used by hand on 2026-10-20 (build-qc dispatch, cookie fetch on test-api) and writes one file the adapter reads |
| 5 | Edges | each blocker has a named outcome: 🔴 not run, 🟡 waiting, or a red check; none is silent |
| 7 | AC | drafts have discriminating inputs: a report without frontmatter, a goal with `Smoke: n/a`, a failed check, a missing tab |

Exemptions: none
Unproven assumptions: the autopilot's Claude in Chrome session can reach test-seller from this laptop (it did by hand on 2026-10-20); local smoke for choda-deck / companion needs a start recipe per workspace, which the plan writes per goal; the loop's 🟢 waits for Butter's QC "yes", so a run without Butter present stops before smoke.
Rounds: 2 · evidence: 11 citations (skill 1, record 2, map 1, repo 1, code 1, tool 1, user 2, goal 3 report 1)
