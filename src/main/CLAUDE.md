# Choda Deck — Main process

## Purpose

Electron main process. Owns all non-UI state: pty session map, IPC handlers, BrowserWindow lifecycle, app shutdown cleanup. The renderer is a dumb display; this layer is where sessions actually live.

## What belongs here

- `BrowserWindow` creation and lifecycle (`createWindow`, `activate`, `window-all-closed`)
- `ipcMain.handle` / `ipcMain.on` handlers for all `pty:*` and future namespace channels
- `sessions: Map<string, pty.IPty>` — the single source of truth for running sessions
- `pty.spawn` + lifecycle (`onData`, `onExit`, `kill`, `resize`, `write`)
- Dev-mode keybindings (F12 toggles devtools) — only when `!app.isPackaged`
- Environment + PATH resolution for spawned claude processes
- Graceful shutdown sequence (hardening pending per research R3)

## What does NOT belong here

- React, JSX, DOM code — renderer only
- xterm.js — renderer only
- Business logic that doesn't require Node APIs — push to renderer if possible
- Direct fs/project-config reads from handlers — those should flow through dedicated modules once MVP introduces `projects.json` loader
- Secret handling — MVP has none; if added, never log

## Key types / entry points

- `createPtySession(id, cwd, cols, rows, webContents)` — the only place `pty.spawn` is called. Guards against double-spawn via `sessions.has(id)` check.
- `sessions: Map<string, pty.IPty>` — module-level. Do not add parallel session stores; extend this map if you need more per-session data (switch to `Map<string, { pty, meta }>`).
- `SPIKE_PROJECT` — hardcoded temporary project config. Will be replaced by a `projects.json` loader. Do not add more hardcoded projects here; when the config loader lands, remove `SPIKE_PROJECT` and the `spike:project` IPC channel with it.
- `ipcMain.handle('pty:spawn', ...)` / `ipcMain.on('pty:input' | 'pty:resize' | 'pty:kill', ...)` — the live IPC surface. Extend per `.claude/rules/electron-ipc.md` conventions.

## Layer-specific rules

- **Always guard `sessions.get(id)` before calling** — the session may have exited between IPC arrival and handler execution.
- **Cleanup on shutdown is best-effort.** `window-all-closed` iterates the map with try/catch and calls `.kill()`. Do not throw from this handler — swallow errors, do not block quit. Hardening per R3 will replace this with a proper Ctrl+C-twice sequence.
- **Do not store webContents references long-term.** `webContents.send` is called from inside pty callbacks; the reference is captured at spawn time. If `webContents` is destroyed, node-pty callbacks still fire — check `webContents.isDestroyed()` before send **if** adding new long-lived listeners.
- **Never block `app.whenReady().then(...)` on async I/O.** Config loading (future) must be synchronous or happen after `createWindow()`.
- **Env passing:** `env: process.env as { [key: string]: string }` — the cast is intentional. node-pty's env type is stricter than Node's. Keep the cast, do not widen or narrow.
- **Platform checks** use `process.platform === 'win32'` / `'darwin'`. The project is Windows-first; `.cmd` suffix on shell commands is Windows-only. Mac/Linux support is deferred but do not introduce Windows-only code without the platform check.

## Open research affecting this layer

- **R3** — Graceful pty shutdown sequence. Current `session.kill()` in `window-all-closed` is a placeholder. Any change to shutdown code must update this ADR-adjacent plan.
- **R11** — PATH handling. Current code inherits `process.env.PATH` unchanged. Fallback scan belongs in this layer when implemented.
