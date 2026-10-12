---
requirement: Goal-driven autopilot — one session per project works tasks + inbox toward a release goal, one commit per DONE, notifies companion
started: 2026-10-12
workspace: choda-deck
status: converged
---

# Discovery — Goal-driven autopilot

Discovery thread: CONV-1791781233600-1

## Round 1 — goal-driven autopilot

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | Inbox items clearly related to the goal are auto-converted and worked in-run, no companion approval | [conversation CONV-1791781233600-1 MSG-1791781298456-3] |
| conversation (chat) | One session per project, no worktrees, one branch per run, one commit per finished item, run anchored to a goal ("release X next week") incl. tests, notify on block | [chat 2026-10-12, seeded in CONV-1791781233600-1] |
| code | No goal/release/milestone entity; grouping = `parentTaskId`, `labels`, `dueDate` on Task | src/core/domain/task-types.ts:72-84 |
| code | InboxItem has no labels/priority/parent — only `linkedTaskId` (1:1 to a task) | src/core/domain/task-types.ts:384-397 |
| skill | burn-backlog = one branch + one PR + squash-merge per task; one firing = one task | choda-burn-backlog/SKILL.md:214-220, :379 |
| skill | DONE needs merge-ancestry proof + every AC ticked → items on a shared, unmerged branch can only reach IMPLEMENTED | choda-burn-backlog/SKILL.md:223-230, :259-261; session-end/SKILL.md:221-227 |
| code | Decide screen filters raw inbox by content prefix `[activity-digest]` / `[improve:<ws>]` / `[improve-note:<ws>]`; actions = convert / archive(reason) | src/adapters/companion/inbox-decide.ts:39-46, :127-129, :170-187 |
| code | Archive reason not persisted unless a conversation is linked | src/core/domain/lifecycle/inbox-lifecycle-service.ts:98-99 |
| code | attention hook: `Notification` → toast with message text; `Stop` → toast only if turn ≥120 s, no reason; file stores no reason | scripts/hooks/attention.mjs:31-54, :88-121 |
| skill | research-inbox verdicts: real bug / works-as-designed / misdiagnosed / needs-data; needs-data never converts | research-inbox/SKILL.md:148-149, :219-230, :258 |
| code | Headless launcher pattern: `claude -p "/skill" --allowedTools …` from a Windows scheduled task, no permission-mode flag | scripts/install-improve-loop-task.mjs:33, :77-87 |
| skill | burn-backlog never addresses context growth; ScheduleWakeup re-enters the same conversation | choda-burn-backlog/SKILL.md:64-71 |
| ADR / conv | Queue runner was removed because manual `/loop` + harness workflow replaced the overnight-batch use case, and linear-cost spawn pipelines were rejected | TASK-982; CONV-1780022899678-9 findings 3/3; ADR-019 (superseded) |
| ADR | Self-built Planner→Generator→Evaluator pipeline removed in favour of native Claude Code orchestration | ADR-014-harness-engine-architecture (superseded) |
| report | Must still stop on: unfamiliar dirty tree, unsatisfied blocker, mid-implementation contract gap; auto-merge needs one per-run opt-in | docs/reports/autonomous-task-loop-best-practices.md:142-170 |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | Butter's stated pain (many projects, manual session switching) + explicit goal-anchoring need | — |
| 2 | Scope & boundary | 6 | In: goal-related tasks + clearly-related inbox, one session/project, one branch, commit/item. Out: worktrees, unrelated items | goal input form; are TODO children authorized by approving the goal; multi-repo goals |
| 3 | Technical contract | 7 | All building blocks located (task/inbox schema, DONE gate, decide filter, attention hook, launcher) | goal representation; DONE timing vs single PR; notification prefix contract |
| 4 | Prior art & constraints | 9 | TASK-982 reason found: /loop replaced queue runner, no spawn pipeline; ADR-014 forbids staged pipeline → must be a skill over /loop, no new subsystem/status/CLI | — |
| 5 | Edges & failure | 4 | Edge list known (blocked item, dirty tree, CI red at end, context exhaustion, relatedness false-positive, inbox arriving mid-run) but none resolved | behaviour per edge |
| 6 | NFR | 3 | Not walked | 12-category pass |
| 7 | Acceptance criteria | 2 | none | blocked on #2, #3, #5 |

**TOTAL = MIN = 2** (dimension 7)
Previous round: — → this round: 2. New evidence? **YES** (15 sources) → may continue.

### Score history
| # | Dimension | R1 |
|---|---|---|
| 1 | Problem & value | 9 |
| 2 | Scope & boundary | 6 |
| 3 | Technical contract | 7 |
| 4 | Prior art | 9 |
| 5 | Edges & failure | 4 |
| 6 | NFR | 3 |
| 7 | Acceptance criteria | 2 |
| | **MIN** | **2** |

### Blocked on human decisions (stop condition: blocked on a human decision)
- Q1 Goal form + authorization: goal = parent task from /choda-plan; does approving the goal once authorize all its children (incl. TODO)?
- Q2 DONE timing with one shared branch: commit per item → IMPLEMENTED, batch-promote to DONE after the single PR merges?
- Q3 Goal spanning two repos (e.g. choda-deck + companion): one branch + one PR per repo?
- Q4 End of run: auto-merge on green CI, or stop for Butter's review?

### Round 2 will look for exactly this
- Butter's answers to Q1-Q4 (#2, #3)
- Resolve each edge case against the answers (#5), then NFR pass (#6)

## Round 2 — goal-driven autopilot

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | thread: no new human messages since R1 | [conversation CONV-1791781233600-1] |
| chat (Butter, AskUserQuestion) | Q1 goal = parent task, approved once → every subtask (and goal-related inbox converted mid-run) is runnable. Q2 commit per item → IMPLEMENTED; DONE batch-promoted after the PR merges. Q3 one branch + one PR per repo. Q4 loop stops at PR-ready, Butter merges | [chat 2026-10-12 answers] |
| gh | Both repos allow merge-commit, rebase and squash merges → "one commit per item on main" needs rebase/merge-commit, and squash breaks per-item ancestry | `gh repo view` choda-deck + choda-deck-companion |
| skill | session-end already proves merge via the PR's merge commit, not branch-tip ancestry (squash/rebase change SHAs) | session-end/SKILL.md:73-79, :268 |
| code | `pendingSource` is a closed prefix switch → adding `[autopilot:<ws>]` is one regex branch | src/adapters/companion/inbox-decide.ts:39-46 |
| code | DecideView renders "Approve → task" for every row → an autopilot notice would be convertible into a task unless hidden | choda-deck-companion/packages/web/src/views/DecideView.tsx:80-90 |
| code | Companion ConversationsView is read-only (no reply/post call) → Butter cannot answer a decision from the companion except Dismiss | choda-deck-companion/packages/web/src/views/ConversationsView.tsx, api.ts (no conversation POST) |
| tool | `PushNotification` sends desktop toast + phone push (Remote Control), auto-skipped when Butter is at the terminal | PushNotification tool schema |

### Edge resolution (dimension 5)
| Edge | Behaviour |
|---|---|
| Dirty tree at start | refuse, no session_start, 🔴 notice names the files |
| Another active session in the same workspace cwd | refuse start (session_list active, same cwd) |
| Item fails a gate twice | stash as `autopilot-blocked-<TASK>`, session_cancel, 🔴 notice, continue |
| Dependents of a blocked item | skipped, listed in the same 🔴 notice |
| Mid-implementation contract gap | 🟡 notice, item skipped (not redefined), continue |
| New goal-related inbox mid-run | queue recomputed every iteration → picked up |
| Inbox relatedness false positive | inclusion reason printed per item in the ⚪ start notice; Dismiss = skip |
| Session/laptop dies | re-invoke same command → same branch, items already IMPLEMENTED with a commit on it are skipped |
| CI red on the PR | 🔴 with PR link, items stay IMPLEMENTED |
| PR closed unmerged | 🔴, items stay IMPLEMENTED |
| Goal with zero open items | ⚪ "nothing to do", stop |
| Context growth | one item per firing (ScheduleWakeup dynamic); all state in DB + git so compaction loses nothing |

### NFR (dimension 6) — 12/12
Performance: no SLA (default). Scalability: no cap, resumable. Availability: needs a live session; resumable by re-invoke. Security: no new endpoint; existing bridge token; notices carry no secrets. Observability: ⚪ start/end + per-item notices + git log. Error handling: table above. Data: notices are raw inbox items, archived on Dismiss. i18n: notice text English (durable-artifact rule). Accessibility: N/A (existing screen). Compliance: N/A. Maintainability: one skill file + two small companion edits. Integration: gh CLI, companion HTTP, PushNotification.

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | carried | — |
| 2 | Scope & boundary | 9 | Q1-Q4 answered; out: worktrees, parallel same-cwd sessions, non-goal items, auto-merge, companion reply UI | — |
| 3 | Technical contract | 9 | goal = parent task; merge proof via PR merge commit (session-end:73-79); prefix branch (inbox-decide.ts:39-46); UI hide (DecideView.tsx:80-90) | — |
| 4 | Prior art | 9 | carried | — |
| 5 | Edges & failure | 9 | 12 edges resolved above against cited mechanisms | — |
| 6 | NFR | 9 | 12/12, defaults per checklist | — |
| 7 | Acceptance criteria | 9 | 14 criteria below, each names surface + verdict | — |

**TOTAL = MIN = 9**. Previous 2 → 9. New evidence? YES.

### Score history
| # | Dimension | R1 | R2 |
|---|---|---|---|
| 1 | Problem & value | 9 | 9 |
| 2 | Scope & boundary | 6 | 9 |
| 3 | Technical contract | 7 | 9 |
| 4 | Prior art | 9 | 9 |
| 5 | Edges & failure | 4 | 9 |
| 6 | NFR | 3 | 9 |
| 7 | Acceptance criteria | 2 | 9 |
| | **MIN** | **2** | **9** |

## ✅ All dimensions ≥ 9 after 2 rounds

Unproven assumptions carried forward:
- Answering a 🟡 decision happens in the autopilot's own terminal session; the companion offers only Dismiss (= skip). Not validated with Butter in a real run.
- Auto-compaction keeps a ~15-item run coherent; untested at that length.
- Butter merges with "Rebase and merge" to keep one commit per item on main; squash would still work for DONE promotion but collapses history.

### Acceptance criteria (draft for conversion)
Companion (machine):
- [ ] `pendingSource('[autopilot:choda-deck] x')` returns source `autopilot`; `pendingSource('[autopilotx:a] x')` returns null — unit test in inbox-decide
- [ ] `POST /inbox/:id/convert` on an `[autopilot:…]` item returns 400 and the item stays `raw` — handler test
- [ ] DecideView renders `decide-archive-<id>` and NO `decide-convert-<id>` for an autopilot row — web vitest

Skill `/choda-autopilot <PARENT-TASK>` (run-verified):
- [ ] `--dry-run` prints the queue (open subtasks in blockedBy→priority order + related inbox with an inclusion reason each + excluded count) and performs zero writes (`git status` and `task_list` unchanged)
- [ ] Relatedness: of a fixture with 4 raw inbox items (linkedTaskId in goal tree / content names a goal task id / cites a file in a goal subtask's File Pointers / unrelated), the dry-run includes exactly the first 3
- [ ] A dirty tree at start → no `session_start`, no commit, one `🔴` `[autopilot:<ws>]` inbox item naming the files
- [ ] Another active session with the same workspace cwd → start refused with that session id
- [ ] Each finished item → exactly one commit on `autopilot/<parent>-<date>` (`git log origin/main..HEAD --grep <TASK>` count = 1) and the task is IMPLEMENTED
- [ ] An item failing a gate twice → stash `autopilot-blocked-<TASK>` exists, tree clean, `🔴` item lists it and its skipped dependents, next independent item still runs
- [ ] A READY high-priority task outside the goal tree is never session-started during the run
- [ ] Killing the session mid-run and re-invoking the same command produces no duplicate commit for already-IMPLEMENTED items
- [ ] End of queue → one PR per touched repo against main, not merged by the loop, one `🟢` item with all PR links + a PushNotification
- [ ] After Butter merges, the next wakeup (≤30 min) promotes to DONE every item whose AC are all ticked and machine-class; items with a human-class AC stay IMPLEMENTED and are listed in the `⚪` end item
- [ ] PR closed unmerged or CI red → `🔴` item with the PR link, no DONE promotion

Assumptions: none exempted.

### Scope addendum (2026-10-12, Butter)
- Out of scope: headless / scheduled `claude -p` launch of the autopilot — token cost. The loop runs only inside an interactive session Butter opened; restart = re-invoke the command.

### Converted
- TASK-2416 (2026-10-12). Notification prefix renamed `[autopilot:<ws>]` → `[loop:<ws>]` so /choda-burn-backlog can share it.
