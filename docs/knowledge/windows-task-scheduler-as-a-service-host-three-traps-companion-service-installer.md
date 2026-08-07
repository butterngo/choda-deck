---
type: gotcha
title: Windows Task Scheduler as a service host — three traps (companion service installer)
projectId: choda-deck
scope: project
refs:
  - path: scripts/install-companion-service.mjs
    commitSha: 983ac7e449b764f1b20fd611e0da7f16cb7e4dd9
createdAt: 2026-07-13
lastVerifiedAt: 2026-08-07
affectedFeatureId: feature-companion-cockpit
---

## Trigger

Changing `scripts/install-companion-service.mjs`, or hosting any long-running Node process via Windows Task Scheduler (a "service" without NSSM/Electron).

## Context

TASK-1375 packaged `dist/companion-server.cjs` as an auto-start hidden background service: Scheduled Task (`ChodaCompanionServer`, logon trigger) → VBS hidden wrapper → launcher `.cmd` → node. All traps below were hit and verified live.

## Business rule

1. **Task Scheduler restart-on-failure does NOT fire for an action that ran-then-exited** (even with `LastTaskResult=1`). Restart-on-crash must live in the launcher `.cmd` itself — an infinite loop with backoff (`:loop / node … / timeout 15 / goto loop`). The `-RestartCount` settings are belt-and-braces only.
2. **The VBS wrapper must wait**: `WScript.Quit shell.Run(cmd, 0, True)`. With `False` the task "completes successfully" the instant node spawns — task state stops tracking the process and failure semantics are lost.
3. **Stopping/ending the task kills wscript+cmd but the node grandchild survives.** Stop/uninstall paths must additionally kill the process owning the port (port-scoped `Get-NetTCPConnection` → `Stop-Process`; never name-scoped kills — see the english-companion collision memory).
4. **The script resolves `dataDir` from its OWN `repoRoot`, so it must be run from the main checkout.** `repoRoot` is derived from `import.meta.url`, and `launcherCmd` / `hiddenVbs` / `logDir` all hang off `dataDir` beneath it. Run `--uninstall` from a git WORKTREE and it computes `<worktree>/data/…`, finds nothing there, and silently leaves the real `companion-service-launcher.cmd` and `companion-service-hidden.vbs` behind in `C:\dev\choda-deck\data`. It still unregisters the scheduled task, so the failure is partial and looks like success — exit code 0, `[install] removed scheduled task`, orphaned artifacts. Run it from the main checkout, or pass `--data-dir` explicitly. Verified 2026-08-06 (TASK-1442).

## Resolution

Traps 1-3 are encoded in `scripts/install-companion-service.mjs` (`stopTask()`, the launcher loop, the waiting VBS). Keep them when refactoring; re-verify crash recovery live (`taskkill` node → healthz green ≤ 36 s) after any change.

Trap 4 is NOT encoded — the script has no guard against being run from a worktree. Making `--uninstall` resolve `dataDir` independently of `repoRoot` (or refusing to run when `git rev-parse --git-common-dir` differs from `.git`) would close it.

**Always verify removal by querying, never by exit code:** `Get-ScheduledTask -TaskName ChodaCompanionServer` returning nothing, plus the port freed, plus both artifact files gone. A clean exit proves only that the script's own try/catch didn't throw.
