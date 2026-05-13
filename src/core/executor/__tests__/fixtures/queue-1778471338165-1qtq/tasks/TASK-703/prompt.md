## Context

`productionExecShell` (the production `ExecShellFn` used by the queue runner to execute AC commands like `pnpm run lint`) is broken on Linux/macOS. Pre-existing bug from TASK-698 (queue lifecycle merge #77), inherited unchanged by TASK-702. Surfaced via GitHub Copilot review on the TASK-702 PR (CONV-1778427579427-21, finding #1). Choda-deck ships as an OSS npm package, so this breaks the queue runner for every non-Windows operator.

### Why it was missed
- Butter develops on Windows; the bug never triggers locally because `shell:true` is set on Windows.
- `queue-lifecycle-service.test.ts` mocks `execShell`, so unit tests never exercise the real spawn path.
- There are no tests under `src/core/executor/` — `runProcess` and `productionExecShell` have zero direct unit-test coverage.

### Root cause (verified against current `main`)

`src/core/executor/queue-claude-spawn.ts:84-89`:
```ts
export const productionExecShell: ExecShellFn = async (cmd, opts) => {
  // comment claims shell:true...
  const r = await runProcess(cmd, [], { cwd: opts.cwd, timeoutMs: opts.timeoutMs })
  return r as ExecShellResult
}
```
delegates to `runProcess` (`src/core/executor/coder.ts:231-238`) which only sets `shell:true` on Windows:
```ts
shell: process.platform === 'win32',
```
On POSIX, `spawn("pnpm run lint", [], { shell: false })` treats the entire 3-word string as the executable name → ENOENT → queue marks task `ac-failed`.

### Caller audit
Verified `runProcess` callers across the codebase (queue-claude-spawn.ts, coder.ts, tester.ts): only `productionExecShell` passes a shell-style command string with empty args. All other callers pass proper `(cmd, args[])`. → Fix the bug at the single broken callsite without touching the existing typed-args path.

### Why we can't just flip `runProcess` to always `shell:true`
`ClaudePCoderDriver.spawnCoder` (`coder.ts:56-69`) passes `userPrompt` as a positional arg in `args[]`. Forcing `shell:true` would re-trigger the Windows cmd.exe positional-arg mangling that PR #79 (commit `7085961`) just fixed via stdin piping.

## Approach — A.1: extract `runShell` helper

1. Add `export function runShell(cmd: string, opts: RunOptions): Promise<ProcResult>` in `src/core/executor/coder.ts`.
   - Internally `spawn(cmd, [], { cwd, env, shell: true, windowsHide: true })`.
   - Same stdout/stderr/timeout/stdin plumbing as `runProcess`.
   - Optionally extract a private `wireChild(child, opts, resolve, reject)` helper shared by both `runProcess` and `runShell` to avoid duplicating the plumbing.
2. Update `productionExecShell` in `queue-claude-spawn.ts` to call `runShell(cmd, opts)` instead of `runProcess(cmd, [], opts)`.
3. Keep `runProcess` unchanged (preserves the Windows-positional behaviour `ClaudePCoderDriver` depends on).
4. Update the misleading "shell:true" comment on `productionExecShell` to describe reality — it now goes through `runShell` (POSIX `sh -c` + Windows `cmd /c`).

### Rejected — A.2 (opt-in `shell` flag on `RunOptions`)
Foot-gun: a future caller could pass `shell:true` with `args[]` and silently regress to the cmd.exe-mangling case PR #79 fixed. A.1 keeps the two execution shapes on distinct API surfaces.

## Acceptance

All criteria below are verifiable autonomously via `pnpm` commands — no manual smoke required in this list.

- [ ] `runShell` exported from `src/core/executor/coder.ts` with the signature `(cmd: string, opts: RunOptions) => Promise<ProcResult>` and internally uses `shell: true`.
- [ ] `productionExecShell` in `src/core/executor/queue-claude-spawn.ts` calls `runShell` instead of `runProcess(cmd, [], …)`. The misleading comment is updated.
- [ ] New test file `src/core/executor/coder.test.ts` exists with at minimum:
  - A `runProcess` test invoking `node -e "process.stdout.write('ok')"` that asserts `exitCode === 0` and stdout contains `ok` — covers the args[] spawn path.
  - A `runShell` test invoking a cross-platform shell conjunction (e.g. `node -e "process.stdout.write('a')" && node -e "process.stdout.write('b')"`) that asserts `exitCode === 0` and stdout contains both `a` and `b` — covers the shell path that was originally broken on POSIX.
- [ ] `pnpm run lint` exits 0.
- [ ] `pnpm test` exits 0 (full suite, including the new `coder.test.ts`).

## Test Plan

1. Implement A.1 (add `runShell`, switch `productionExecShell` over, update comment, optionally extract `wireChild`).
2. Add `src/core/executor/coder.test.ts` with the two unit cases above. Use `node -e "…"` for cross-platform stdout assertions instead of `echo` (Windows + POSIX both ship `node` in the dev environment).
3. Run `pnpm run lint` and `pnpm test` — both must be green.
4. (Out of AC — operator step, optional) Manual POSIX smoke: in WSL2 or a Linux box, pick an auto-safe task with `pnpm run lint` in its AC and run `node dist/cli.cjs run-queue --workspace <id>`. Confirm the AC step executes the lint command and gets a normal exit code (not ENOENT). This is the real-world proof but not part of the auto-verifiable AC.

## File Pointers

- `src/core/executor/coder.ts` — add `runShell` here, alongside `runProcess` (around lines 222-272). Consider extracting `wireChild` helper.
- `src/core/executor/queue-claude-spawn.ts` — update `productionExecShell` (lines 84-89) to use `runShell`.
- `src/core/executor/coder.test.ts` — new file with the two unit cases.
- `src/core/domain/lifecycle/queue-lifecycle-service.ts` — `ExecShellFn` interface (no change expected).
- `src/core/domain/lifecycle/queue-lifecycle-service.test.ts` — existing mock pattern (no change).

## Out of Scope (deliberate)

- Rewriting AC parser to tokenize into `cmd, args[]` — would lose `&&` / `||` / pipe support that the shell-based contract advertises.
- Migrating queue runner away from shell execution — too invasive and orthogonal.
- Adding CI matrix for POSIX — separate hygiene task; this fix unblocks POSIX users immediately.
- Manual POSIX live smoke — captured in Test Plan as operator follow-up, not in AC.

## Related

- Origin inbox: INBOX-150 (converted by this task).
- Research conversation: CONV-1778469911711-1.
- Upstream review: CONV-1778427579427-21 (Copilot review on TASK-702 PR), finding #1.
- Prior related fix: PR #79 (commit `7085961`) — Windows positional-arg mangling via stdin piping in `createQueueClaudeSpawner`.
- Upstream merges: TASK-698 (introduced bug), TASK-702 (inherited unchanged).
- ADR-019 — autonomous queue runner operating envelope.
- ADR-017 — headless spawn strategy.

## Scope

~1–1.5h: ~30 min implement (extract `runShell` + optional `wireChild`), ~30 min tests, ~15 min review polish, buffer for lint/test debug.
