---
type: gotcha
title: Windows Task Scheduler as a service host — three traps (companion service installer)
projectId: choda-deck
scope: project
refs:
  - path: scripts/install-companion-service.mjs
    commitSha: 306045e706dad87bc85ee857b43c2154a7f69479
createdAt: 2026-07-13
lastVerifiedAt: 2026-08-03
affectedFeatureId: feature-companion-cockpit
---

## Trigger

Changing `scripts/install-companion-service.mjs`, or hosting any long-running Node process via Windows Task Scheduler (a "service" without NSSM/Electron).

## Context

TASK-1375 packaged `dist/companion-server.cjs` as an auto-start hidden background service: Scheduled Task (`ChodaCompanionServer`, logon trigger) → VBS hidden wrapper → launcher `.cmd` → node. All three traps below were hit and verified live.

## Business rule

1. **Task Scheduler restart-on-failure does NOT fire for an action that ran-then-exited** (even with `LastTaskResult=1`). Restart-on-crash must live in the launcher `.cmd` itself — an infinite loop with backoff (`:loop / node … / timeout 15 / goto loop`). The `-RestartCount` settings are belt-and-braces only.
2. **The VBS wrapper must wait**: `WScript.Quit shell.Run(cmd, 0, True)`. With `False` the task "completes successfully" the instant node spawns — task state stops tracking the process and failure semantics are lost.
3. **Stopping/ending the task kills wscript+cmd but the node grandchild survives.** Stop/uninstall paths must additionally kill the process owning the port (port-scoped `Get-NetTCPConnection` → `Stop-Process`; never name-scoped kills — see the english-companion collision memory).

## Resolution

All three are encoded in `scripts/install-companion-service.mjs` (`stopTask()`, the launcher loop, the waiting VBS). Keep them when refactoring; re-verify crash recovery live (`taskkill` node → healthz green ≤ 36 s) after any change.
