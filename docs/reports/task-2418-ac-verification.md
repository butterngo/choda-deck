# TASK-2418 — AC verification

**Task:** choda-autopilot skill: start checks, goal queue with inbox relatedness, --dry-run
**Parent:** TASK-2416 · **PR:** butterngo/choda-skills#17 · **Merge commit:** `18fe114` (ancestor of origin/main, proven)
**Run:** /choda-burn-backlog, label `autopilot`, 2026-10-12

## Done (4/4)

| # | Criterion | Evidence |
|---|---|---|
| 1 | `--dry-run` prints open subtasks in topological order, zero writes | Fixture goal TASK-2424: printed TASK-2425 → TASK-2426 (blockedBy). Before and after the run, `git status --porcelain` (main + skills), every choda-deck task row (id, status, updated_at), every inbox row and the session count were byte-identical |
| 2 | 4 fixture inbox items → exactly the first 3 included with reasons, `excluded: 1` | INBOX-2211 (a) linked to TASK-2426 · INBOX-2212 (b) names TASK-2425 · INBOX-2213 (c) cites `src/fixture/autopilot-probe.ts` · INBOX-2214 excluded. Over the real raw inbox the same 3 were included and 103 excluded |
| 3 | Dirty tree → no session, no commit, one `[loop:<ws>] 🔴` notice naming the file | Untracked `docs/reports/task-2417-ac-verification.md` → INBOX-2215, 0 sessions created |
| 4 | Same-cwd active session → stop with its id, no `session_start` | SESSION-1791367303145-1 (TASK-2312, workspace main) → INBOX-2216, 0 sessions created |

## Not done
None.

## Needs a human
None.

## Findings
- **Defect caught before commit.** The fallback "first workspace" resolved to `C:\tmp\ac11-fixture`, because `project_list` returns workspaces in no meaningful order. The fallback is now the workspace whose `cwd` equals the project's `cwd`.
- **Executor caveat.** The skill was executed by the same agent that wrote it. The inbox classification ran as a deterministic script applying the documented a/b/c rule, not by judgement.
- **The start check bites in practice.** SESSION-1791367303145-1 (TASK-2312) has been active on `main` since 2026-10-07. While it stays open, a real autopilot run on choda-deck `main` will refuse to start.
- **Cleanup.** Fixture tasks TASK-2424/2425/2426 were cancelled, and INBOX-2211..2216 archived.
