---
type: spike
title: "SPIKE findings — headless `claude -p` spawn contract"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-04-19
lastVerifiedAt: 2026-04-29
---

# SPIKE findings — headless `claude -p` spawn contract

Spike script: `scripts/spike-harness-headless.mjs` (worktree `spike/task-537-headless-claude`). 10 tests against real `claude -p` (Claude Code v2.1.114, Node 24, Windows). Total spend ~$0.70 across 7 runs.

## TL;DR — 10/10 behaviors validated

- CLAUDE.md auto-discovery **walks up parent tree**, not just cwd. Isolate cwd to avoid parent leak.
- `--allowed-tools` **does NOT restrict tools** — it only pre-approves. Use `--tools <list>` for real restriction.
- `--max-budget-usd` is a **soft cap** — cost checked after each turn, can overspend ~2x before abort.
- Workspace `.claude/settings.local.json` **leaks** via `cwd` by default. `--setting-sources user` fixes.
- `Bash(git *)` subcommand scope works (note: **space inside parens**, not colon).
- `cwd = git worktree path` works correctly — Claude sees worktree's branch, toplevel, and CLAUDE.md.
- `--no-session-persistence` **does prevent `.jsonl` transcripts** — only residue is an empty `~/.claude/projects/<encoded-cwd>/memory/` dir shell. No data persisted. Cleanup optional.

## Per-assumption results

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| 1 | CLAUDE.md auto-discovery + walk-up | PASS — walks up | Inner marker + outer marker both quoted. Claude reads CLAUDE.md at cwd AND parent dirs. |
| 2 | `--allowed-tools "Read Grep Glob"` blocks Bash | **FAIL as tool restriction** | Claude reply: `"bashRan": true, "reason": "Bash tool executed successfully"`. Allowlist only pre-approves, doesn't restrict. |
| 3 | `Bash(git *)` subcommand scope (space, not colon) | PASS | `git status` ran (exit 128 = not a repo), `curl` denied by permission sandbox. Pattern syntax correct. |
| 4 | `--max-budget-usd` cap + abort | PASS (soft) | Cap $0.02, actual cost $0.047, exit=1. Abort happens AFTER turn completes — overspend up to ~2x. |
| 5 | `--output-format json` parsing | PASS | Payload has `result`, `total_cost_usd`, `duration_ms`, `usage`, `session_id`, `stop_reason`. Clean JSON. |
| 6 | Permission behavior in `-p` without `--permission-mode` | FAIL as protection | Bash ran even with only `Read` in `--allowed-tools`. Default mode in `-p` auto-approves (no human to prompt). |
| 7 | `.claude/settings.local.json` leak via cwd | PASS — leaks | Env marker from workspace leaked into Claude (default). `--setting-sources user` prevents. |
| 8 | `--tools "Read,Grep,Glob"` restricts loaded set | PASS | Claude reply: `"bashAvailable": false, "note": "Bash tool is not available"`. Correct enforcement mechanism. |
| 9 | `cwd = git worktree path` | PASS | `git rev-parse --show-toplevel` → worktree path, `git branch --show-current` → spike branch, CLAUDE.md auto-loaded. |
| 10 | `--no-session-persistence` vs cache dir residue | PASS (with caveat) | Flag prevents `.jsonl` transcripts. **Empty `memory/` dir shell still created** at `~/.claude/projects/<encoded-cwd>/` — no files inside, no data persisted. `--bare` prevents the dir entirely but also disables CLAUDE.md auto-discovery (unusable for pipeline). See Change 6 below. |

## Implications for ADR-014

### Change 1 — Tool restriction mechanism

ADR-014 Planner spawn uses `--allowed-tools "Read Grep Glob"`. **Wrong flag**. Must be:

```
--tools "Read,Grep,Glob"           # actual restriction (enforce)
--allowed-tools "Read,Grep,Glob"   # pre-approve (no prompt) within loaded set
```

In `-p` mode there is no human to prompt, so `--permission-mode default` does not deny unlisted tools — `--tools` (availability gate) is the only reliable restriction.

Per-stage recommendation:

| Stage | `--tools` |
|---|---|
| Planner | `Read,Grep,Glob` |
| Generator | `Read,Grep,Glob,Edit,Write,Bash` + `--allowed-tools "Bash(git *) Bash(npm *)"` to scope shell |
| Evaluator | `Read,Grep,Glob,Bash` + `--allowed-tools "Bash(npm *) Bash(git diff*)"` |

### Change 2 — Hermetic spawn (mandatory flags)

Every HarnessRunner spawn must include:

```
--setting-sources user          # prevent workspace settings.local.json leak
--no-session-persistence        # no pollution of user's /resume picker
--output-format json            # parseable output
--model <sonnet|opus>           # explicit, don't inherit
```

### Change 3 — Budget cap is soft

`--max-budget-usd N` allows overspend up to ~2x before abort. Set cap to **~50% of ADR-014 budget**:

- ADR-014 says Planner budget $0.5 → pass `--max-budget-usd 0.25`.
- Expected worst case $0.5.
- Verify against `total_cost_usd` in JSON output for accurate ledger.

### Change 4 — CLAUDE.md walk-up: how to isolate

Claude walks up parent tree for CLAUDE.md. Two options:

**A. Use worktree as cwd (recommended for pipeline):** confirmed to work — Claude reads `<worktree>/CLAUDE.md` and, since `C:\dev\` and `C:\dev\choda-deck.worktrees\` have no CLAUDE.md, no parent leak. This is the natural HarnessRunner pattern (spawn per pipeline in its own worktree).

**B. Explicit isolation with `--bare`:** disables CLAUDE.md auto-discovery; then pass `--add-dir <workspace>` manually. More ceremony; only use if cwd can't be isolated.

### Change 5 — Argv length (Windows)

Test 5 argv was 143 bytes — tiny. PLANNER_ROLE prompt expected < 4 KB. Piping prompt via **stdin** (confirmed working in spike) avoids 32 KB Windows argv limit entirely — **use stdin for prompts**, not positional arg.

### Change 6 — Session cache residue (decision: accept)

Confirmed via Test 10 + filesystem inspection after 7 spike runs:

- With `--no-session-persistence`: no `.jsonl` transcript is written to `~/.claude/projects/<encoded-cwd>/`. Only an empty `memory/` subdirectory shell is created (async, ~1-3s after process exit on Windows). No files inside, no data persisted.
- With `--bare` + `--no-session-persistence`: no cache dir at all. But `--bare` also disables CLAUDE.md auto-discovery → not usable for pipeline (stages need CLAUDE.md for project facts).

**Decision for HarnessRunner — Option A (accept):** keep `--no-session-persistence`, accept the empty `memory/` dir shells. They contain no data, cost negligible disk, and do not pollute Butter's `/resume` picker (which only sees `.jsonl` sessions). No active cleanup routine in v1. If residue ever becomes noisy, add a sweep of `~/.claude/projects/<encoded-worktree-cwd>/` on session_end — one-liner `rm -rf`. Deferred.

## Recommended canonical spawn signature

```ts
spawn(CLAUDE_CMD, [
  '-p',
  '--model', 'sonnet',
  '--output-format', 'json',
  '--no-session-persistence',
  '--setting-sources', 'user',
  '--tools', 'Read,Grep,Glob',             // stage-specific
  '--allowed-tools', 'Bash(git *)',        // stage-specific pre-approve
  '--max-budget-usd', '0.25',              // 50% of target
], {
  cwd: worktreePath,                       // isolated worktree
  stdio: ['pipe', 'pipe', 'pipe'],
})
// then pipe prompt to child.stdin, end stdin, read stdout JSON
```

## Windows spawn pitfall

Node 20+ refuses to spawn `.cmd` directly without `shell: true` (CVE-2024-27980). With `shell: true`, args are concatenated without escaping. Workaround used in spike: build full command string with manual cmd.exe-safe quoting (any arg with ` ()<>&|^"*?` wrapped in double quotes). HarnessRunner implementation must replicate this quoting or shell out via a deterministic wrapper.

## Open follow-ups

- Verify same behavior on Opus + Haiku models (spike used Sonnet only).
- Verify `--max-budget-usd` abort behavior for multi-turn sessions (spike only tested single-prompt).
- Decide: quoting helper in `src/core/harness/spawn-utils.ts` vs shell wrapper script.
- `--permission-mode` matrix not fully explored — `dontAsk` / `plan` behavior under `-p` not tested (may matter for Generator when Edit permission needed without hanging).
