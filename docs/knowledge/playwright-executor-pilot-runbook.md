---
type: learning
title: "Playwright FE test executor pilot — runbook"
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/cli/commands/run.ts
    commitSha: e2153d55fdc164804e636b61c0b9340fb3c29633
  - path: src/core/executor/coder.ts
    commitSha: e2153d55fdc164804e636b61c0b9340fb3c29633
  - path: src/core/executor/tester.ts
    commitSha: b0dc075f1e3640c4a8e3c54dcb579928279237e2
  - path: src/core/executor/static-scan.ts
    commitSha: b0dc075f1e3640c4a8e3c54dcb579928279237e2
  - path: src/core/executor/ac-report.ts
    commitSha: b0dc075f1e3640c4a8e3c54dcb579928279237e2
  - path: src/core/executor/coder-driver.ts
    commitSha: b0dc075f1e3640c4a8e3c54dcb579928279237e2
  - path: src/core/domain/auto-safe-validator.ts
    commitSha: 7270e00e712940d91a1aab566231e1791153f255
createdAt: 2026-05-08
lastVerifiedAt: 2026-05-08
---

# Playwright FE test executor pilot — runbook

How to drive the `choda-deck run` executor for FE Playwright tests. Pilot context: TASK-679, currently scoped to `remote-workflow`. Read [TASK-679 task body](../../) and CONV-1778229375963-1 / CONV-1778245859930-7 for design rationale; this doc is the operator's manual.

## Quick start

```bash
# from choda-deck repo root, with bundle built and dev server up at the target
node dist/cli.cjs run TASK-XXX --workspace remote-workflow --json
```

Exit 0 = all ACs pass, no diff drift, static scan ok. Anything else returns a non-zero code (table below) and writes evidence under `<CHODA_PLAYWRIGHT_ARTIFACT_ROOT>/<project>/<taskId>/<timestamp>/`.

## Prerequisites

| Need | How to check / set |
|---|---|
| `claude` CLI in PATH (Coder spawn) | `claude --version` returns `2.x` |
| Bundle built | `pnpm run build:cli` produces `dist/cli.cjs` (1.4 MB) |
| Target task gate-ready | Task has both labels `fe-playwright-test` AND `auto-safe`, body has `## Acceptance` (with `pnpm`/`node`/```bash command), `## File Pointers` (concrete `.ts`/`.spec.ts` path), `## Scope` (`~Nh` estimate ≤3h) |
| Workspace registered | `mcp__choda-tasks__workspace_add` for the target repo cwd. Pilot uses `remote-workflow` → `C:\dev\test\remote-workflow` |
| Dev server running at the target's `baseURL` | Check `playwright.config.ts` of target repo. remote-workflow: `npm run dev` at `http://localhost:3000/buy-for-me` |
| Browsers installed in target repo | `pnpm exec playwright install chromium` (one-time per repo) |
| Artifact dir env (optional) | `CHODA_PLAYWRIGHT_ARTIFACT_ROOT` — default `C:\temp\playwright` |

## 3 run modes

Use the cheapest mode that exercises what you want to test. Layer up only when needed.

### 1. `--dry-run` (free, ~2s)

Validates label gate + auto-safe body shape + workspace cwd resolution. Does not spawn Coder or Tester.

```bash
node dist/cli.cjs run TASK-XXX --workspace remote-workflow --dry-run --json
```

When to use: confirming a fresh task passes the gate before committing to a real run; debugging "why did exit 4 fire".

### 2. `--skip-coder` (free, ~30-60s)

Skips Coder entirely; uses a hand-crafted spec you point to. Tester pipeline runs end-to-end: static scan → Playwright run → AC mapping → git-diff guard → AC report.

```bash
node dist/cli.cjs run TASK-XXX --workspace remote-workflow \
  --skip-coder --spec-path e2e/tests/<feature>.spec.ts --json
```

When to use: validating Tester pipeline without spending Haiku $$, debugging spec failures, smoke-testing pipeline changes.

### 3. Full run (~$0.10-0.30 Haiku, ~1-3 min)

Coder spawns `claude -p` Haiku 4.5 with the 8-rule system prompt + task body, writes `<feature>.spec.ts` under `e2e/tests/`, commits to the current branch (no push), then Tester runs the spec.

```bash
node dist/cli.cjs run TASK-XXX --workspace remote-workflow --json
# add --max-budget-usd 0.50  to raise per-run ceiling (default 0.30)
```

When to use: actual pilot tasks. Each successful run = one data point toward TASK-679 pilot success criteria (≤1 flaky / 5, ≤2 interventions / 5, total ≤$1).

## CLI flag reference

```
node dist/cli.cjs run <taskId> --workspace <workspaceId> [options]
```

| Flag | Default | Notes |
|---|---|---|
| `--workspace <id>` | required | Resolves to cwd via `getWorkspace(id)` (cross-project) |
| `--worktree <path>` | from workspace | Override cwd directly |
| `--artifact-root <path>` | env or `C:\temp\playwright` | Out-of-tree by default to keep diff guard clean |
| `--pnpm-bin <bin>` | `pnpm` | Override the package-manager binary |
| `--claude-bin <bin>` | `claude` | Override claude CLI binary path |
| `--max-budget-usd <n>` | `0.30` | Per-Coder budget; warning if actual cost exceeds this |
| `--skip-coder` | off | Requires `--spec-path` |
| `--spec-path <path>` | — | Repo-relative `.spec.ts` (used with `--skip-coder`) |
| `--dry-run` | off | Validate gates only, no spawn |
| `--json` | off | Emit JSON summary to stdout |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All ACs pass, diff clean, static scan ok |
| 1 | Any AC `fail` / static scan fail / git-diff drift / Coder syntax verify fail |
| 2 | Bad args (missing positional, missing `--workspace`, etc.) |
| 3 | Task not found in DB |
| 4 | Label gate failed (missing `fe-playwright-test` or `auto-safe`, or auto-safe body shape invalid) |

## AC report format

Every run writes `<artifactDir>/ac-report.json`:

```json
{
  "taskId": "TASK-XXX",
  "workspaceId": "remote-workflow",
  "branch": "<git branch at run time>",
  "startedAt": "<iso>",
  "endedAt": "<iso>",
  "entries": [
    {
      "acId": "AC-1",
      "status": "pass | fail | skip",
      "evidence": ["screenshot:test-results/.../test-failed-1.png", "trace:..."],
      "notes": "<optional reason>"
    }
  ],
  "diffGuard": { "before": "<diff>", "after": "<diff>", "clean": true },
  "staticScan": { "ok": true, "violations": [] },
  "exitCode": 0
}
```

How `entries` are populated:
- `extractAcIds(task.body)` pulls every `AC-N` mention from the task body, sorted numerically.
- For each AC id, the Tester scans Playwright JSON results for tests whose title starts with that id (`test('AC-1 …')`).
- All matching tests pass → `status: pass`. Any fail → `status: fail`. No matching test → `status: skip` with `notes: "no Playwright test titled with this AC id"`.
- Tests without `AC-N` prefix are bucketed under a synthetic `orphan-tests` entry — fail-fast, treat as bug in spec authoring.

`reportHasFailure(report)` (used to compute exit code) returns true if **any** of: diffGuard not clean, staticScan not ok, any entry status `fail`. Skips do not count as failure.

Evidence paths are relative to `artifactDir`; full files live under `<artifactDir>/test-results/`.

## Cost & budget

- AC-10 ceiling: total ≤ $1 across the first 5 piloted tasks.
- Per-task soft cap: `--max-budget-usd` (default $0.30). The CLI logs a `cost-warn` note if actual `total_cost_usd` from `claude -p` JSON exceeds this. Note: the cap is informational/post-hoc; the underlying `claude -p --max-budget-usd` is enforced by the CLI itself per turn but may overshoot the first turn (see ADR-017).
- Tester is free (plain Node child_process, no LLM in the loop).
- If costs trend high: drop to `claude-haiku-4-5-20251001` confirmed in driver options; otherwise revisit system prompt size or inline mocks bloating context.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Exit 3 "task not found" | Task id typo or task in different project | `node dist/cli.cjs task show TASK-XXX` to confirm |
| Exit 4 "missing fe-playwright-test" / "auto-safe" | Label gate | Add labels via `mcp__choda-tasks__task_update --labels [...]` |
| Exit 4 "Missing ## Scope section" / "Missing ## File Pointers" | Body section heading mismatch | Validator regex is exact match — heading must be exactly `## Scope` and `## File Pointers` (case insensitive, no suffixes after the heading text) |
| Exit 4 "no parseable hour estimate" | Scope has no `~Nh` token | Add a line like `Estimate: ~2h` in `## Scope` |
| `workspace ... not registered and no --worktree override` | Workspace id unknown | `mcp__choda-tasks__workspace_add` OR pass `--worktree <abs-path>` |
| All AC entries `fail` with same auth/redirect error | Target app shows a blocking screen (auth, market selector, onboarding) | Update the target's `mockAuth.ts` (or equivalent) to cover the missing route. This is the target repo's responsibility, not the pilot. |
| Coder fail spawn `claude -p exited 1` | claude CLI not in PATH or auth expired | `claude /login`; check `claude --version` |
| Coder writes spec but `locateNewSpec` returns null | Coder wrote to wrong path | System prompt enforces `e2e/tests/`. If the target repo uses a different `testDir`, adjust system prompt or pass via task body |
| `git-diff guard failed — Tester run mutated worktree` | Playwright wrote artifacts inside the worktree (e.g. `test-results/` not redirected) | Confirm `--output=<artifactDir>/test-results` is being passed; check `.gitignore` covers any other tooling output |
| `static scan rejected spec` with rule `expect.soft without // justify:` | Coder used a soft assertion | Either drop the `expect.soft`, or add a `// justify: <reason>` comment within 2 lines above |
| Pass-path never demoed in `feat/task-606-usemarket-integration` branch | Market selector blocks all e2e tests until `mockAuth` extends | Wait for remote-workflow team to land market mock, or switch branch / cherry-pick the market mock when available |

## Pilot validation criteria (TASK-679)

Track these manually for the first 5 piloted tasks:

| Metric | Target |
|---|---|
| Flaky (rerun pass) tasks | ≤ 1 / 5 |
| Manual interventions (Butter fixes Coder output, retries with hint, etc.) | ≤ 2 / 5 |
| Total Haiku cost | ≤ $1 |
| Tester report matches Butter's manual review | 0 false positive, 0 false negative |

Pass → expand pattern to INBOX-091 (general executor) + add Copilot CLI driver. Fail → debug failure mode, decide on Sonnet escalation or system-prompt refinement.

## Phase 2 follow-ons (out of pilot scope)

- Pluggable Coder driver — Copilot CLI as second `CoderDriver` impl
- Auto-fix loop on Tester fail (note: this is where harness pattern fails, design carefully)
- Auto PR creation after green run
- Sonnet escalation logic (Haiku failed → retry with Sonnet)
- Other projects beyond `remote-workflow`
- File watcher / cron auto-pick of new `fe-playwright-test` tasks
- Snapshot-update workflow

## References

- TASK-679 — pilot scope + acceptance criteria + pilot validation criteria
- CONV-1778229375963-1 — initial design lock (closed)
- CONV-1778245859930-7 — architecture refinement (Tester = Playwright runner subprocess, not MCP Playwright)
- ADR-017 — headless spawn strategy (`claude -p` defaults)
- TASK-652 / [auto-safe-label-spec](./auto-safe-label-spec.md) — gate validator
- ADR-014 (superseded) — harness pattern; the executor must NOT regress into harness
- TASK-669 — choda-deck CLI v1 surface this extends
- INBOX-091 — general executor (parent of pilot)
- INBOX-092 — data-testid audit on remote-workflow
