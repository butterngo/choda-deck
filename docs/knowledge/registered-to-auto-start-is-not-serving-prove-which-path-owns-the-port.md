---
type: gotcha
title: Registered to auto-start is not serving — prove which path owns the port
projectId: choda-deck
scope: project
refs:
  - path: scripts/install-companion-service.mjs
    commitSha: 983ac7e449b764f1b20fd611e0da7f16cb7e4dd9
createdAt: 2026-08-07
lastVerifiedAt: 2026-08-07
affectedFeatureId: feature-companion-cockpit
---

## Trigger

You are about to retire one auto-start path in favour of another — or you are reasoning about "the companion is running" at all. Also bites when a health check passes and you assume you know *which* process answered it.

## Context

The companion can be started two ways: the Task Scheduler service (`ChodaCompanionServer`, logon trigger → VBS → launcher `.cmd` → `node dist/companion-server.cjs`) and the Electron app (HKCU `...\CurrentVersion\Run` → `Choda Companion.exe`, which bundles `resources/adapter/companion-server.cjs`).

Verified live 2026-08-06 (TASK-1442): **both were registered simultaneously**, and the state everyone assumed — "the Electron app is the launch path now" — was false. Port 7338 was held by pid 25456, `node C:\dev\choda-deck\dist\companion-server.cjs`, parented by `cmd /c companion-service-launcher.cmd`. The old service had been serving since 2026-08-04. The Electron app was not running at all.

When the service was removed and the Electron app launched on its own, it produced 5 processes bound only to ephemeral ports (53324/53325), never touched 7338, and `/healthz` refused the connection. Its own log showed a long history of `[launcher] server exited -1073741205` (0xC000042B) restart loops interleaved with successful binds — so it *had* bound before and kept dying.

## Business rule

**Registration is not execution, and execution is not service.** Three distinct facts, none implying the next:

1. A path is *registered* to auto-start (scheduled task exists / Run key exists).
2. Its process is *running*.
3. That process *owns the port you care about*.

The Electron app satisfied (1) and (2) while failing (3), and looked entirely healthy doing it. A green `/healthz` proves only that *something* is listening — never which path put it there.

**Two registered auto-start paths can coexist silently, and the loser leaves no trace.** Nothing warns you; whichever binds first wins and the other simply never serves.

## Resolution

Establish ownership before drawing conclusions, on Windows:

```
Get-NetTCPConnection -LocalPort 7338 -State Listen        # who is listening
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"   # CommandLine + ParentProcessId
```

The **parent chain is the discriminator** — `cmd /c companion-service-launcher.cmd` means the Task Scheduler path; an Electron parent means the app. `CommandLine` alone is not enough: both hosts run a `companion-server.cjs` of identical size, so the bundle path distinguishes them but the process name does not.

Before retiring any fallback launcher, prove the replacement serves *with the fallback absent* — and prove it survives, not just starts. A crash-restart loop looks identical to health if you sample once inside a bind window. Sample twice, minutes apart, and check the log for `server exited` lines appended in between.

Corollary for the app itself: failing to host the adapter must surface in the UI. This went unnoticed for days precisely because the app appeared to run normally while serving nothing (tracked as TASK-1590 AC-5).

## Related

- `windows-task-scheduler-as-a-service-host-three-traps-companion-service-installer` — the installer's own traps, including that `--uninstall` must run from the main checkout
- TASK-1590 — the 0xC000042B adapter-host crash; TASK-1442 (decommission the service) is blocked on it
