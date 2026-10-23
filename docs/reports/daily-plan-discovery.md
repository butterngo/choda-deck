---
requirement: 'Daily plan: "what I did today / what I do tomorrow" across all projects'
started: 2026-10-23
workspace: Main
status: converged
---

# Discovery — Daily plan: "what I did today / what I do tomorrow" across all projects

Source: INBOX-2315 · Discovery thread: CONV-1792717131156-1

## Round 1 — daily plan

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | thread just opened, no human posts yet | [conversation CONV-1792717131156-1] |
| inbox | the problem, in Butter's words, with a real 4-goal example (juvenis-maxime TASK-2636/2648/2657/2564) and a hand-walked critical path | INBOX-2315 |
| skill | focus is cwd/workspace-scoped and ranks session > in-progress > pinned > overdue > ready > due-soon; no notion of a plan or a date | ~/.claude/skills/choda-task-focus/SKILL.md:6,25-49 |
| skill | /next picks through /choda-task-focus §2 — so it inherits the same blind spot | ~/.claude/skills/next/SKILL.md:81-91 |
| code | Task already carries `pinned: boolean`, `dueDate`, `blockedBy[]` — pinned has no order and no date | src/core/domain/task-types.ts:72-89 |
| code | sessions are listed per project only — a cross-project "done today" must loop over projects | src/core/domain/interfaces/session-repository.interface.ts:7 |
| code | the daily digest already has per-day `sessionsCompleted`, `mergesToDefault`, `byProject`, `byTask` — numbers, not a list of what moved | src/core/domain/activity/activity-digest.ts:44-83 |
| code | digests are JSON files written per day and served at GET /activity/digests | src/core/domain/activity/activity-runner.ts:235 · src/adapters/companion/activity.ts:23 |
| code | the decide screen groups pending inbox items by `source` (activity-digest / improve / improve-note / loop) — a "plan" block would be a fifth source or its own screen | choda-deck-companion/packages/web/src/views/DecideView.tsx:248-251 |
| code (prior art) | Runs (TASK-2531) already joins a goal's subtasks + AC ticks + handoffs + commits per run — the closest existing "goal" view | src/adapters/companion/runs.ts:32-38 |
| code (prior art) | attention files list Claude sessions waiting on Butter across all cwds — another cross-project signal | src/adapters/companion/attention.ts:5-14 |
| code | no dependency-path / unblocked-order helper exists in src — critical path is computed by hand (/choda-plan does it in prose) | grep `topolog|criticalPath|unblocked` over src: 0 relevant hits |
| knowledge | no ADR on daily planning; feature-companion-cockpit names "what am I doing / done / next" as an original goal of the companion | feature-companion-cockpit |
| web | — | (nothing sought) |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | INBOX-2315 concrete example; focus + /next are cwd-scoped and plan-blind (SKILL.md:6, next:81-91) | — |
| 2 | Scope & boundary | 4 | wishlist only; nothing stated as out; v1 cut unknown | Butter: v1 cut + what is explicitly out |
| 3 | Technical contract | 5 | surfaces known (task-types.ts:72-89, activity-digest.ts:44-83, session-repo:7, DecideView:248) but no storage shape for the plan | entity decision (new table vs pinned+dueDate) |
| 4 | Prior art & constraints | 7 | no ADR; Runs (runs.ts:32) and cockpit goal overlap | read feature-companion-cockpit body + TASK-2416 autopilot goal model |
| 5 | Edges & failure | 2 | none examined | plan stale next morning, task DONE/CANCELLED overnight, plan item blocked, two days without a plan, timezone day boundary |
| 6 | NFR | 2 | not walked | nfr-checklist pass |
| 7 | Acceptance criteria | 1 | none | blocked on #2 and #3 |

**TOTAL = MIN = 1** (dimension 7)
Previous round: — → this round: 1. New evidence? **YES** (12 sources) → may continue.

### Score history
| # | Dimension | R1 |
|---|---|---|
| 1 | Problem & value | 9 |
| 2 | Scope & boundary | 4 |
| 3 | Technical contract | 5 |
| 4 | Prior art | 7 |
| 5 | Edges & failure | 2 |
| 6 | NFR | 2 |
| 7 | Acceptance criteria | 1 |
| | **MIN** | **1** |

### Round 2 will look for exactly this
- **Blocked on a human decision** (§5): storage shape, who writes tomorrow's list, where "done" comes from, the v1 cut. Asked in chat 2026-10-23.
- Then: edges (#5) and NFR (#6) against the chosen shape; prior art (#4) from feature-companion-cockpit + TASK-2416.

## Round 2 — daily plan

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation / chat | Butter, 2026-10-23: storage = new `day_plan` entity (ordered items, kind task\|goal); Claude proposes tomorrow, Butter confirms; "done" computed live from DB; v1 = MCP tools + focus/next read the plan, end-of-day skill, companion Today screen, critical-path helper. Thread itself: no human posts | [conversation CONV-1792717131156-1] + chat AskUserQuestion 2026-10-23 |
| code | there is NO task status history table — "tasks moved today" can only come from `tasks.updated_at` (bumped by any edit) or session handoff `tasksUpdated` | schema.ts:85-887 (no status/event table for tasks) · task-types.ts:176-181 |
| code | sessions carry `startedAt`/`endedAt`/`handoff{commits,resumePoint,tasksUpdated}` — the precise half of "done" | task-types.ts:176-219 |
| code | merges per repo already classified (merge/direct/bot) from the default-branch log | src/core/domain/activity/default-branch-log.ts:4-24 |
| code | day boundary helper exists: `localDate(ms, tz)`, default tz Asia/Ho_Chi_Minh | activity-digest.ts:14,140-152 |
| code (template) | deploy_checks (TASK-2605) is the newest table and walks the full path: SQLite schema, PG migration, repo, MCP tool, companion route, sync | schema.ts:839-852 · postgres/migrations.ts (2 hits) · syncable-tables.ts:33 · http-server.ts:183 · mcp-tools/deploy-check-tool.ts |
| code (precedent) | a local-only table with no remote consumer is NOT added to SYNCABLE_TABLES (ADR-026) | schema.ts:858-862 (investigations) |
| task | TASK-2056 rule: a feature may land SQLite-only but the PG gap must be recorded in the same PR (task still TODO) | TASK-2056 ## Acceptance AC-7 |
| code | blockedBy ids are global (no project check) and only DIRECT cycles are rejected — a path helper must handle cross-project blockers and longer cycles | task-repository.ts:230-251 |
| code | session_start resolves the workspace from the cwd it is given — "do it" on a plan item in another project cannot start there from this cwd | mcp-tools/session-tools.ts:179-188 |

### Edges enumerated (dimension 5)
1. No plan for today → focus/next behave exactly as now (tiers unchanged).
2. Plan item's task went DONE/CANCELLED overnight → shown done/skipped; "item 1" = first OPEN item.
3. Goal item whose whole path is DONE → goal item counts done.
4. Plan item still blocked (a blocker not DONE) → skipped as "blocked by X", next runnable item leads.
5. Item in another project/workspace than cwd → focus names it with its workspace cwd; "do it" says "open <cwd>" instead of starting a session in the wrong repo.
6. Confirm twice for the same date → replaces that date's items (idempotent upsert), no duplicates.
7. Day boundary in Asia/Ho_Chi_Minh; planning after midnight → target date must be shown and confirmed, not inferred.
8. blockedBy cycle longer than 1 hop → path helper reports the cycle, does not loop.
9. Plan item refId unknown → rejected at write time (same rule as validateBlockedBy).
10. Yesterday's unfinished items → carried into the next proposal, never silently dropped.

### NFR (dimension 6)
| Category | Requirement | Source |
|---|---|---|
| Performance | plan read < 1s; "done" query over all projects < 3s | default |
| Scalability | single user, ≤ ~20 items/day | assumed |
| Availability | none — local tool | default |
| Security | local adapter only; no secrets stored | default · pending sync decision |
| Observability | none beyond existing logs | assumed |
| Error handling | unknown refId → reject; cycle → report; adapter down → companion error state (DecideView pattern) | DecideView.tsx:228-237 |
| Data | keep all plans indefinitely (tiny) | assumed |
| i18n | English artifacts; dates in Asia/Ho_Chi_Minh | CLAUDE.md · activity-digest.ts:14 |
| Accessibility | not required v1 | default |
| Compliance | n/a | default |
| Maintainability | follows the deploy_checks layering | schema.ts:839 |
| Integration | MCP tools + one adapter GET route; PG parity per TASK-2056 rule | TASK-2056 |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | carried (no change) | — |
| 2 | Scope & boundary | 8 | v1 cut decided [chat 2026-10-23]; out-list proposed, not confirmed | Butter confirms out-list (sync/team, edit in companion, auto-run) |
| 3 | Technical contract | 8 | storage per deploy_checks template (schema.ts:839); done sources (task-types.ts:176-219, default-branch-log.ts) | decide: accept updated_at approximation vs add a status-change record |
| 4 | Prior art & constraints | 9 | TASK-2056 rule; ADR-026 local-only precedent (schema.ts:858); nothing rejected | — |
| 5 | Edges & failure | 8 | 10 edges, each sourced above | decide edge 7 rule (target date after midnight) |
| 6 | NFR | 8 | 12/12 walked | sync decision fixes Security/Integration rows |
| 7 | Acceptance criteria | 6 | draft ACs below depend on 3 open decisions | decisions → finalize |

**TOTAL = MIN = 6** (dimension 7)
Previous round: 1 → this round: 6. New evidence? **YES** (10 sources) → may continue.

### Score history
| # | Dimension | R1 | R2 |
|---|---|---|---|
| 1 | Problem & value | 9 | 9 |
| 2 | Scope & boundary | 4 | 8 |
| 3 | Technical contract | 5 | 8 |
| 4 | Prior art | 7 | 9 |
| 5 | Edges & failure | 2 | 8 |
| 6 | NFR | 2 | 8 |
| 7 | Acceptance criteria | 1 | 6 |
| | **MIN** | **1** | **6** |

### Round 3 will look for exactly this
- Blocked on a human decision (§5): out-list, status-history approach, sync/PG, after-midnight target date.

## Round 3 — daily plan

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation / chat | Butter, 2026-10-23: add a status-change record; day_plan local-only + SQLite-only; before 05:00 local counts as the same day; OUT of v1 = editing in companion, auto-run/headless, per-member plans, end-of-day reminder. Thread: no human posts | [conversation CONV-1792717131156-1] + chat AskUserQuestion 2026-10-23 |
| code | every local status write goes through one method — `TaskRepository.update` (`sets.push('status = ?')`) — so one hook there logs all of task_update, session_start (IN-PROGRESS) and session_end (IMPLEMENTED) | task-repository.ts:89-151 · session-lifecycle-service.ts:79,185 |
| code | sync pull inserts task rows with generic SQL, bypassing the repository → pulled status changes are NOT logged | sync-pull.ts:162-164 |

### Contract (dimension 3)
- Tables, SQLite only, not in SYNCABLE_TABLES:
  `day_plans(date TEXT PK, note TEXT, created_at, confirmed_at)` ·
  `day_plan_items(date, position, kind CHECK IN ('task','goal'), ref_id, label, PK(date, position))` ·
  `task_status_changes(id INTEGER PK, task_id, from_status, to_status, at)`.
- Item state is derived, never stored: task DONE/CANCELLED → done/skipped; any blockedBy not DONE → blocked; else open. Goal item = target task; its path is the open transitive blockedBy closure, topologically ordered; done when the path is empty and target DONE.
- `planDate(now) = localDate(now − 5h, 'Asia/Ho_Chi_Minh')`; "tomorrow" = planDate(now) + 1. Same boundary for the "done" half.
- MCP: `day_plan_get({ date? })`, `day_plan_set({ date, items, note? })` (replace), `goal_path({ taskId })`.
- Adapter: `GET /day-plan?date=YYYY-MM-DD`. Companion: read-only Today view.
- Skills: new `/plan-tomorrow`; `/choda-task-focus` gains tier 0 "today's plan" (cross-project); `/next` picks the first open, unblocked plan item.

### Draft acceptance (dimension 7)
1. [machine] `task_update` TODO→READY writes exactly one `task_status_changes` row (TODO→READY); a title-only update writes zero.
2. [machine] `session_start` and `session_end` each write one row (→IN-PROGRESS, →IMPLEMENTED).
3. [machine] `day_plan_set` twice for one date (3 items, then 2) leaves exactly 2 items in the given order.
4. [machine] `day_plan_set` with an unknown refId errors naming that id and writes nothing.
5. [machine] `goal_path`: chain A←B←C with A DONE returns [B, C]; a blocker in another project is included; a 3-hop cycle returns an error naming the cycle and terminates.
6. [machine] `day_plan_get` item state: DONE task → done; open blocker → blocked naming it; else open; goal with empty path and DONE target → done.
7. [machine] `day_plan_get` done-half on a fixture day lists status changes and ended sessions from two different projects; an event at 04:59 local of D+1 belongs to D.
8. [machine] `planDate`: 2026-10-23 22:00 +07 → 2026-10-23; 2026-10-24 00:30 +07 → 2026-10-23.
9. [machine] `GET /day-plan?date=` → 200 with items; no plan → 200 `{ items: [] }`; malformed date → 400.
10. [machine] Companion Today view renders items in plan order with state; no plan → "No plan for <date>"; adapter down → error state, not the empty state.
11. [human] `/choda-task-focus` run from an unrelated cwd, with a plan whose item 1 is in juvenis-maxime, leads with item 1 and its workspace cwd; with no plan the board matches today's tiers.
12. [human] `/next` picks the first open, unblocked plan item over a higher-priority READY task.
13. [human] `/plan-tomorrow` shows the done half, proposes an ordered list carrying yesterday's open items, shows the target date, and writes nothing until confirmed.

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | carried | — |
| 2 | Scope & boundary | 9 | v1 in + out confirmed [chat 2026-10-23] | — |
| 3 | Technical contract | 9 | single status write point task-repository.ts:89-151; template schema.ts:839; local-only per schema.ts:858 | — |
| 4 | Prior art & constraints | 9 | carried | — |
| 5 | Edges & failure | 9 | 10 edges + #11 sync-pulled changes unlogged (sync-pull.ts:162); after-midnight rule decided | — |
| 6 | NFR | 9 | Security/Integration fixed by local-only decision | — |
| 7 | Acceptance criteria | 9 | 13 criteria, each names its surface and a pass/fail difference; 10 machine, 3 human | — |

**TOTAL = MIN = 9**
Previous round: 6 → this round: 9. New evidence? **YES** (3 sources).

### Score history
| # | Dimension | R1 | R2 | R3 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | 9 | 9 |
| 2 | Scope & boundary | 4 | 8 | 9 |
| 3 | Technical contract | 5 | 8 | 9 |
| 4 | Prior art | 7 | 9 | 9 |
| 5 | Edges & failure | 2 | 8 | 9 |
| 6 | NFR | 2 | 8 | 9 |
| 7 | Acceptance criteria | 1 | 6 | 9 |
| | **MIN** | **1** | **6** | **9** |

## ✅ All dimensions ≥ 9 after 3 rounds

| # | Dimension | Score | WHY it earned 9 |
|---|---|---|---|
| 1 | Problem & value | 9 | INBOX-2315 real example; focus/next are cwd-scoped and plan-blind (choda-task-focus/SKILL.md:6, next/SKILL.md:81-91) |
| 2 | Scope & boundary | 9 | in/out both decided by Butter 2026-10-23 |
| 3 | Technical contract | 9 | status hook at the single write point task-repository.ts:89-151; table shape follows deploy_checks (schema.ts:839) minus sync (schema.ts:858) |
| 4 | Prior art | 9 | TASK-2056 SQLite-only rule; ADR-026 local-only precedent; no rejected prior design |
| 5 | Edges | 9 | 11 edges, incl. cross-project/long-cycle blockedBy (task-repository.ts:230-251) and sync-pull bypass (sync-pull.ts:162) |
| 6 | NFR | 9 | 12/12 rows, defaults cited |
| 7 | AC | 9 | 13 falsifiable criteria, surface named, machine/human classified |

Exemptions: none
Unproven assumptions carried forward:
- status history starts on ship day — no backfill;
- status changes pulled via sync are not logged (sync-pull.ts:162);
- PostgresTaskService will not implement the new methods — a recorded SQLite-only gap per TASK-2056 (whose baseline file does not exist yet);
- the quality of Claude's proposed ordering is judged only by Butter's confirm step.
Rounds: 3 · evidence: ~25 citations across code (17), skills (3), tasks/inbox (2), knowledge (1), Butter's decisions (2)

## Round 4 — scope widened: companion daily report + outstanding-work scan

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | Butter: "trên companion sẽ có 1 cái daily report kiểu hôm qua xong những gì, hôm nay sẽ làm những gì, sẽ scan hết projects phải chắc được việc còn tồn đọng" | [conversation CONV-1792717131156-1 MSG-1792717479980-6] |
| chat decisions | outstanding = stuck tasks + yesterday's unfinished plan items + git per workspace + raw inbox; display = per-project summary, expandable, oldest first; a new Today screen as the landing page, computed live, no snapshots | AskUserQuestion 2026-10-23 |
| data (live, 2026-10-23 01:05 +07) | scale across 14 projects: 151 IMPLEMENTED not DONE · 5 IN-PROGRESS with no active session · 3 active sessions (oldest 2026-05-18) · 6 overdue · 409 raw inbox (bpa 180, choda-deck 103, global 71) | readonly query on data/database/choda-deck.db |
| code | the adapter's rule for git: a git failure is 409, never `200 + []`, because empty reads as "clean" — the same rule makes "no outstanding work" provable | src/adapters/companion/workspace-commits.ts:4-11 |
| code | stale-session detection exists (active > 3 days AND a merge names the task) | src/core/domain/activity/session-reconcile.ts:5-10 |
| code | waiting Claude sessions are already readable from attention files | src/adapters/companion/attention.ts:5-14 |
| code | landing route today: decide if anything pending, else sync | choda-deck-companion/packages/web/src/views/LandingRedirect.tsx:1-14 |
| code | no `gh` call anywhere in src — open-PR detection is a new external dependency | grep `'gh'` over src: 0 hits |
| memory | the active gh account gets 403 on butterngo/* repos — a PR lookup will fail for some repos | reference_butterngo_gh_token |

### Contract additions (dimension 3)
- `GET /daily-report?date=` → `{ date, yesterday: { statusChanges[], sessionsEnded[], merges[] }, today: { items[] /* day_plan_get */ }, outstanding: { projects: [{ projectId, counts: { implementedNotDone, inProgressNoSession, staleSessions, overdue, carriedPlanItems, rawInbox, unmergedBranches, dirtyWorkspaces, openPrs }, items: [...] }], workspaces: [{ id, cwd, git: 'ok' | 'not-a-repo' | 'missing' | 'failed', prs: 'ok' | 'unknown' }] } }`.
- "yesterday" = planDate(now) − 1 (05:00 boundary).
- Git per workspace cwd: `git status --porcelain` (dirty), `git for-each-ref refs/heads` vs default branch `--merged` (unmerged branches); `gh pr list --state open --json` with per-repo timeout. Any failure → that workspace's state is `failed`/`unknown`, listed explicitly, never counted as clean.
- Raw inbox: counts + oldest per project only, no item list.
- Companion: new `/today` view, three blocks (Yesterday done / Today plan / Outstanding); LandingRedirect → `/today`.

### Edges added
12. Workspace cwd not on disk → `missing`, listed. 13. cwd is not a git repo (vault-rooted projects) → `not-a-repo`, listed, not an error. 14. gh not authenticated / 403 → `prs: 'unknown'` for that repo. 15. A slow repo or gh call → per-call timeout, partial report with that workspace marked, never a hang. 16. Archived workspaces excluded.

### Acceptance added
14. [machine] `/daily-report` outstanding counts per project sum to the same totals as direct SQL over tasks/sessions/inbox on a fixture DB (completeness proof).
15. [machine] A workspace whose git command fails appears with `git: 'failed'` and is NOT counted as clean; a non-repo cwd appears as `not-a-repo`.
16. [machine] With `gh` failing for one repo, that repo shows `prs: 'unknown'` and the rest of the report still returns 200.
17. [machine] "yesterday" on 2026-10-24 03:00 +07 is 2026-10-22; at 2026-10-24 06:00 +07 it is 2026-10-23.
18. [machine] Companion `/today` renders the three blocks; an outstanding project row expands to its items oldest-first; `#/` lands on `/today`.
19. [human] Open the packaged companion in the morning: every project with outstanding work is listed, and the totals match `task_list` for one spot-checked project.

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | + live scale: 151 stuck, 409 raw inbox | — |
| 2 | Scope & boundary | 9 | widened scope decided [chat 2026-10-23] | — |
| 3 | Technical contract | 9 | /daily-report shape; git rule workspace-commits.ts:4-11; reconcile + attention reused | — |
| 4 | Prior art | 9 | carried; LandingRedirect TASK-2381 is the screen being replaced as landing | — |
| 5 | Edges & failure | 9 | 16 edges incl. missing cwd, non-repo, gh 403, timeouts | — |
| 6 | NFR | 9 | Performance revised: report < 3s on SQL; git/gh run in parallel with per-call timeout | — |
| 7 | Acceptance criteria | 9 | 19 criteria (15 machine, 4 human) | — |

**TOTAL = MIN = 9**
Previous round: 9 → this round: 9 (scope widened, re-earned). New evidence? **YES** (9 sources).

### Score history
| # | Dimension | R1 | R2 | R3 | R4 |
|---|---|---|---|---|---|
| 1 | Problem & value | 9 | 9 | 9 | 9 |
| 2 | Scope & boundary | 4 | 8 | 9 | 9 |
| 3 | Technical contract | 5 | 8 | 9 | 9 |
| 4 | Prior art | 7 | 9 | 9 | 9 |
| 5 | Edges & failure | 2 | 8 | 9 | 9 |
| 6 | NFR | 2 | 8 | 9 | 9 |
| 7 | Acceptance criteria | 1 | 6 | 9 | 9 |
| | **MIN** | **1** | **6** | **9** | **9** |

Unproven assumptions added: gh account access per repo is not solved in v1 (shown as unknown); git scan cost across ~30 workspaces is estimated, not measured.

## Mockup — 2026-10-23

Companion Today screen mockup: https://claude.ai/artifact/DhZ965R86dUSG4YPq63UuT (built from real data, 2026-10-23 01:05–02:10 +07).

Git measured across all 30 registered workspaces (read-only `git status --porcelain` + `git branch --no-merged <default>`):
- 25 scanned · 3 folders missing (mantu365-tools, ActivityManagement, search-engine-api) · 2 not a git repo (ichiba-k8s, http-proxy).
- New edge 17: a workspace nested inside another workspace's repo (tms FE at C:/dev/test/tms/fe inside BE's C:/dev/test/tms) reports the same repo twice — dedupe by `git rev-parse --show-toplevel`.
- Default branch differs per repo (master vs main) — resolve from `origin/HEAD`, not hard-coded.
- IMPLEMENTED-not-DONE re-read at 02:05: 157 (juvenis-maxime 39 → 45 since 01:05) — the screen must be computed live.
