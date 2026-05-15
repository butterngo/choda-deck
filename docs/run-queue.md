# run-queue & queue start — Usage Guide

## Overview

Two commands, two execution strategies:

| Command | Execution | Worktrees | On failure |
|---|---|---|---|
| `choda-deck run-queue` | Sequential | Main worktree (in-place) | Halt immediately, mark `auto-failed`, exit 1 |
| `choda-deck queue start` | Parallel-ready | Each task gets its own `git worktree add` | Continue-on-failure (default), exit 1 at end |

**When to use `run-queue`:**
- Simple batch of independent tasks where you want fast feedback and are OK stopping on first failure.
- No branching isolation needed — tasks work on the current checked-out branch.
- Simpler setup: no worktrees parent dir, no `gh` auth check.

**When to use `queue start`:**
- Tasks touch overlapping files, so you need branch isolation.
- You want all tasks to complete regardless of individual failures (`--force-continue` not needed — continue is the default policy).
- Output ends up on separate `auto/<taskId>` branches, ready for PR creation.
- Requires `gh` to be authenticated (preflight checks `gh auth status`).

Both commands pick up tasks that are `READY`, carry the `auto-safe` label, and pass structural validation.

---

## Prerequisites — auto-safe task requirements

A task must satisfy all of the following before the queue runner will pick it up:

1. **Status: READY** — task must be in the `READY` state.

2. **Label: `auto-safe`** — task must carry this label explicitly.

3. **`## File Pointers` section** — must list at least one concrete file path (ending in `.ts`, `.tsx`, `.js`, `.json`, `.md`, `.yml`, etc.).

4. **`## Acceptance` (or `## Acceptance Criteria`) section** — must include at least one verifiable shell command. Accepted forms:
   - Inline `pnpm <cmd>` or `node <cmd>`
   - A fenced ` ```bash ``` ` block

5. **`## Scope` section** — must contain an hour estimate in a parseable form (`~2h`, `1.5h`, `2-3h`). The upper bound must be **≤ 3h**.

6. **No `auto-failed` label** — tasks that previously failed are skipped until you strip the label.

7. **Build-sensitive rule** — if the body mentions `build:mcp`, `build:cli`, `loader`, or `asset copy`, the `## Acceptance` section must include a smoke step (`pnpm run build:mcp`, `pnpm run build:cli`, or a line containing `smoke`).

The `queue start` preflight additionally checks (per task):
- Worktree path `<worktreesParentDir>/<taskId>` does not already exist.
- Branch `auto/<taskId>` does not already exist in the repo.
- Any `## File Pointers` entry that includes a line range references a file that actually exists at `baseSha`.

---

## accounts.json setup

`accounts.json` lets you pin a run to a specific Claude login profile, useful when you have multiple API seats or want to alternate load.

**Where `data/` resolves to:**

Priority order (from `src/core/paths.ts`):
1. `CHODA_DB_PATH` set → `dataDir` is the directory containing that path.
2. `CHODA_DATA_DIR` set → that value is `dataDir`.
3. Fallback → `<cwd>/data` (i.e. `C:\dev\choda-deck\data` when run from the project root).

**File location:** `<dataDir>/accounts.json`

**Format:**

```json
{
  "accounts": {
    "<profile-name>": "<path-to-claude-config-dir>"
  }
}
```

The value is the path to the Claude config directory (the folder that contains `claude_desktop_config.json` / `settings.json`). The runner passes this to the `claude` binary so it picks up that profile's API key and settings.

**Current `data/accounts.json` in this repo:**

```json
{
  "accounts": {
    "main": "C:\\Users\\hngo1_mantu\\.claude",
    "alt": "C:\\Users\\hngo1_mantu\\.claude-mantu"
  }
}
```

- `main` — default personal Claude account.
- `alt` — second account (mantu identity).

If `accounts.json` is absent, `--account` still parses but resolves to `null`, and the runner falls back to the default `claude` profile. If the file exists but the named account is missing, the command exits 2 immediately.

---

## `choda-deck run-queue`

### Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--workspace <id>` | string | **required** | Workspace label (e.g. `choda-deck`) |
| `--max-cost-per-task <n>` | number | `1.50` | Per-task post-hoc cost cap in USD. Spawn budget is `floor(cap * 0.95 * 100) / 100`. |
| `--max-tasks <n>` | integer | all eligible | Stop after at most N tasks. |
| `--dry-run` | flag | false | Validate workspace + clean tree + list eligible tasks. No spawn. |
| `--json` | flag | false | Emit JSON summary to stdout instead of plain text. |
| `--claude-bin <path>` | string | `claude` | Path to the `claude` executable. |
| `--pnpm-bin <path>` | string | — | Reserved (not used for AC exec yet). |
| `--model <id>` | string | `claude-sonnet-4-6` | Claude model ID. Override per-task via `model:<id>` label. |
| `--account <name>` | string | — | Profile name from `data/accounts.json`. |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | All tasks DONE |
| 1 | One or more tasks auto-failed (queue halted on first failure) |
| 2 | Bad args (missing `--workspace`, bad `--account`, bad number format) |
| 3 | Workspace not found |
| 4 | Pre-flight clean-tree check failed (dirty working tree) |
| 5 | Cost cap exceeded (per-task `cost-cap` or per-queue `queue-cost-cap`) |
| 130 | SIGINT — Ctrl+C pressed twice |

First Ctrl+C sends a graceful signal: current task finishes, queue stops before the next one. Second Ctrl+C force-exits immediately.

### Examples

```sh
# Dry run — list eligible tasks, check clean tree, no spawn
choda-deck run-queue --workspace choda-deck --dry-run

# Normal run
choda-deck run-queue --workspace choda-deck

# Cap spend, run at most 3 tasks
choda-deck run-queue --workspace choda-deck --max-cost-per-task 0.80 --max-tasks 3

# Use the alt account
choda-deck run-queue --workspace choda-deck --account alt

# JSON output for scripting
choda-deck run-queue --workspace choda-deck --json | jq '.totalCostUsd'

# Cheaper model with a tighter budget
choda-deck run-queue --workspace choda-deck --model claude-haiku-4-5-20251001 --max-cost-per-task 0.30
```

---

## `choda-deck queue start`

### Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--workspace <id>` | string | **required** | Workspace label |
| `--base-ref <ref>` | string | `main` | Git ref to fork all worktrees from. Resolved to a SHA at preflight. |
| `--worktrees-dir <path>` | string | `<workspace.cwd>.worktrees` | Parent dir for per-task worktrees. Must already exist and be writable. |
| `--branch-prefix <prefix>` | string | `auto/` | Per-task branch name is `<prefix><taskId>`. |
| `--force-continue` | flag | false | Skip per-task preflight failures; run tasks that passed. Still aborts on global errors. |
| `--max-cost-per-task <n>` | number | `1.50` | Per-task post-hoc cost cap in USD. |
| `--max-tasks <n>` | integer | all eligible | Stop after at most N tasks. |
| `--dry-run` | flag | false | Run preflight only. Print what would happen. No worktrees created, no spawns. |
| `--json` | flag | false | Emit JSON summary to stdout. |
| `--claude-bin <path>` | string | `claude` | Path to the `claude` executable. |
| `--model <id>` | string | `claude-sonnet-4-6` | Claude model. Override per-task via `model:<id>` label. |
| `--account <name>` | string | — | Profile name from `data/accounts.json`. |

### Preflight policy

Preflight runs before any spawn. Two tiers:

- **Global errors** (always abort): `baseRef` unresolvable, `worktreesParentDir` missing or non-writable, `gh auth status` fails.
- **Per-task failures**: existing worktree path, existing branch, structural validation errors, missing file pointers at baseSha.

Default: any failure (global or per-task) aborts the whole batch. Use `--force-continue` to skip only per-task failures and run the rest.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | All tasks DONE (or dry-run preflight OK) |
| 1 | One or more tasks FAILED mid-run |
| 2 | Bad args |
| 3 | Workspace not found |
| 4 | Preflight aborted (default abort-all policy) or global preflight error |
| 130 | SIGINT |

Unlike `run-queue`, a per-task failure mid-run does **not** halt the batch — the runner continues to the next task and exits 1 at the end. Exit 4 only fires when the whole batch was blocked at preflight.

### Examples

```sh
# Dry run — preflight check, no spawn
choda-deck queue start --workspace choda-deck --dry-run

# Normal run — fork from main, worktrees at default location
choda-deck queue start --workspace choda-deck

# Fork from a feature branch
choda-deck queue start --workspace choda-deck --base-ref feat/infra

# Custom worktrees dir
choda-deck queue start --workspace choda-deck --worktrees-dir C:\dev\worktrees\choda

# Run the rest even if some tasks fail preflight
choda-deck queue start --workspace choda-deck --force-continue

# Alt account, cap at 5 tasks
choda-deck queue start --workspace choda-deck --account alt --max-tasks 5
```

---

## Workflows thông dụng

### Dry-run trước, chạy sau

Always dry-run first on a new batch:

```sh
choda-deck run-queue --workspace choda-deck --dry-run
# hoặc
choda-deck queue start --workspace choda-deck --dry-run
```

Output shows eligible task count and any preflight errors. Zero cost.

### Giới hạn chi phí

```sh
# Cap per-task ở $0.50, tối đa 5 tasks → worst case $2.50
choda-deck run-queue --workspace choda-deck --max-cost-per-task 0.50 --max-tasks 5
```

For `run-queue` there is also a per-queue guard: the runner halts before spawning if `cumulative + perTaskCap > maxQueueCost`. Set `maxQueueCost` via the programmatic API (not exposed as a CLI flag yet).

### Phân tải giữa hai accounts

Run a subset with each account:

```sh
# First 3 tasks on main
choda-deck run-queue --workspace choda-deck --account main --max-tasks 3

# Next 3 tasks on alt (run-queue picks up where it left off by task eligibility)
choda-deck run-queue --workspace choda-deck --account alt --max-tasks 3
```

For `queue start`, the same `--account` applies to the whole batch. To split, you need two invocations with `--max-tasks` and task state management in between.

### Model override per-task via label

Add a `model:<id>` label to a task to override the model just for that task:

```
model:claude-haiku-4-5-20251001
```

The queue runner reads this label and uses it instead of `--model`. Useful for mixing cheap and expensive tasks in the same batch.

### Recovering from `auto-failed`

When a task fails, the runner adds the `auto-failed` label and leaves the task in `READY`. To retry:

1. Investigate the artifacts (see below).
2. Fix the task body or the code.
3. Remove the `auto-failed` label from the task.
4. Re-run.

---

## Artifacts — `queue-run.json`

Every run writes artifacts under `<dataDir>/artifacts/`:

- `run-queue` → `artifacts/queue-<queueRunId>/`
- `queue start` → `artifacts/queue-start-<queueRunId>/`

**Top-level files:**

| File | Description |
|---|---|
| `queue-run.json` | Full run metadata (see below) |
| `queue.jsonl` | Append-only event stream: `task.started`, `task.finished`, `run.finished`/`run.failed` |
| `report.md` | Human-readable markdown summary (rendered after the run) |

**Per-task subdirectory** (`tasks/<taskId>/`):

| File | Description |
|---|---|
| `prompt.md` | Task body as sent to Claude |
| `claude.json` | Raw Claude SDK response JSON |
| `diff.patch` | `git diff` output from the task's cwd |
| `ac-0.log`, `ac-1.log`, … | One log per AC command: command, exit code, stdout, stderr |

### `queue-run.json` schema (key fields)

```jsonc
{
  "queueRunId": "1747289000000-abc123",
  "workspaceId": "choda-deck",
  "branch": "main",            // run-queue only — current branch at start
  "commitSha": "abc...",       // run-queue only — HEAD at start
  "baseRef": "main",           // queue start only
  "baseSha": "abc...",         // queue start only — frozen SHA all worktrees fork from
  "model": "claude-sonnet-4-6",
  "startedAt": "2026-05-15T...",
  "endedAt": "2026-05-15T...",
  "maxCostPerTask": 1.5,
  "totalCostUsd": 0.84,
  "halted": false,             // run-queue: true if stopped early
  "haltReason": null,
  "haltCode": null,            // "cost-cap" | "queue-cost-cap" | "spawn-error" | "claude-error" | "ac-failed"
  "preflightAborted": false,   // queue start only
  "tasks": [
    {
      "id": "TASK-123",
      "outcome": "DONE",       // "DONE" | "FAILED" | "SKIPPED" | "SKIPPED_PREFLIGHT"
      "costUsd": 0.42,
      "numTurns": 7,
      "account": "main",       // null if --account not passed
      // queue start also includes:
      "worktreePath": "C:\\dev\\choda-deck.worktrees\\TASK-123",
      "branch": "auto/TASK-123",
      "headSha": "def..."
    }
  ]
}
```

The `account` field reflects the `--account` value passed to the CLI for that run. It is `null` when no `--account` was specified.

To find the artifact dir of the last run:

```sh
# plain text output includes the path on the last line:
choda-deck run-queue --workspace choda-deck
# → "  artifacts: C:\dev\choda-deck\data\artifacts\queue-<id>"
```

Or with `--json`:

```sh
choda-deck run-queue --workspace choda-deck --json | jq -r '.artifactDir'
```
