# Architecture — Choda Deck

## Overview

Electron-based desktop application with three standard processes — main (Node.js), preload (context bridge), renderer (React). The unique piece is the PTY layer: each project tab hosts a live `node-pty` process spawned in that project's cwd, piped bidirectionally through IPC into an `xterm.js` instance in the renderer. Session state lives in the main process (process handles + IPC event streams); the renderer only holds the visual terminal and forwards user input.

Architecture style: **process-isolated, IPC-mediated, session-as-entity**. The unit of state is a `Session` (one pty + one xterm instance + one project cwd).

## Layers / Components

| Component | Role |
|---|---|
| `src/main/index.ts` | Main process. Electron lifecycle, BrowserWindow, PTY session map, IPC handlers |
| `src/preload/index.ts` | Preload script. Exposes `window.api.pty.{spawn,input,resize,kill,onData,onExit}` via contextBridge |
| `src/renderer/src/App.tsx` | Renderer. React UI, xterm.js terminal, FitAddon, ResizeObserver wiring |
| `scripts/spike-pty.mjs` | Plain-Node PTY validation harness (no Electron) — diagnostic tool for native-module / PTY issues |
| `scripts/dev.mjs` | Dev wrapper that unsets `ELECTRON_RUN_AS_NODE` before invoking `electron-vite dev` (fix for commit `7187791`) |
| `electron.vite.config.ts` | Build pipeline config for main/preload/renderer |

## Key flows

### Session spawn (first click on a project)

```
Renderer click
  → window.api.pty.spawn(id, cwd, cols, rows)
  → ipcRenderer.invoke('pty:spawn', ...)
  → main createPtySession(id, cwd, cols, rows, webContents)
  → pty.spawn('claude.cmd', [], { cols, rows, cwd, env })
  → sessions.set(id, ptyProcess)
  → ptyProcess.onData → webContents.send(`pty:data:${id}`, data)
  → renderer ipcRenderer.on(`pty:data:${id}`) → term.write(data)
```

### User keystroke

```
xterm.onData(data)
  → window.api.pty.input(id, data)
  → ipcRenderer.send('pty:input', id, data)
  → main sessions.get(id).write(data)
  → claude stdin
```

### Resize

```
ResizeObserver fires
  → fitAddon.fit()
  → term.cols / term.rows updated
  → window.api.pty.resize(id, cols, rows)
  → main sessions.get(id).resize(cols, rows)
  → ConPTY SIGWINCH-equivalent
```

### Session exit

```
pty onExit({ exitCode })
  → webContents.send(`pty:exit:${id}`, exitCode)
  → sessions.delete(id)
  → renderer shows exited banner
```

### App quit

```
window-all-closed
  → for each session: session.kill()
  → sessions.clear()
  → app.quit() (non-darwin)
```

## Integration points

| System | Direction | Protocol | Purpose |
|---|---|---|---|
| `claude.cmd` CLI | out (spawn) | ConPTY on Windows, pty on POSIX | Interactive Claude Code session per project |
| Electron main ↔ renderer | bidirectional | IPC via contextBridge | `pty:*` channels for stream + control |
| OS filesystem | read | fs (indirect via claude) | Claude accesses project cwd |
| `%APPDATA%/choda-deck/projects.json` | read (future) | JSON | User project list (V2 — MVP still hardcoded) |

## Data model

| Entity | Description |
|---|---|
| `Session` (implicit) | `{ id, cwd, pty, cols, rows }` held in `sessions: Map<string, pty.IPty>` in main |
| `SpikeProject` (preload type) | `{ id, cwd, shell }` — single hardcoded project in spike phase |
| `Project` (MVP target) | `{ id, cwd, label, shell? }` from `projects.json` |

## IPC contract

Channel naming: `pty:<verb>` for commands, `pty:<verb>:<sessionId>` for per-session event streams.

| Channel | Kind | Direction | Payload |
|---|---|---|---|
| `pty:spawn` | invoke | R→M | `(id, cwd, cols, rows)` → `{ ok, id }` |
| `pty:input` | send | R→M | `(id, data: string)` |
| `pty:resize` | send | R→M | `(id, cols, rows)` |
| `pty:kill` | send | R→M | `(id)` |
| `pty:data:${id}` | on | M→R | `data: string` (stream) |
| `pty:exit:${id}` | on | M→R | `exitCode: number` |
| `spike:project` | invoke | R→M | `()` → `SpikeProject` (temporary, spike-only) |

## Quality attributes

| Attribute | How it is ensured |
|---|---|
| Responsiveness | xterm.js renders direct on canvas; IPC batches data chunks; FitAddon debounce (TODO R4) |
| Session persistence | Sessions live in main process `Map`; xterm instances mounted once in renderer, never disposed on tab switch |
| Graceful shutdown | `window-all-closed` iterates session map and calls `.kill()` before `app.quit()` — sequence pending hardening per R3 |
| Crash resilience | Per-tab state machine `idle | running | exited-ok | crashed`; banner + manual restart on failure (Q1 decision) |
| Cross-environment reliability | PATH inherited from Electron main; fallback scan for `claude` install locations TBD per R11 |
| Security | `contextIsolation: true`, `sandbox: false` (required for preload Node APIs); renderer has no direct Node access, only `window.api` surface |

## Architectural note — polymorphic view container (MVP target, not yet implemented)

Main pane must be a **polymorphic view container**, not hardcoded single xterm. `<ProjectWorkspace>` hosts `<ViewRouter>` choosing between registered view types. MVP implements `terminal`; V2+ adds `note`, `tasks`, `adr`, `memory`, `graph` without rewriting the shell. Current `App.tsx` is a single-terminal spike — to be refactored during MVP build.

## Open research questions affecting architecture

- R1 — xterm.js TUI fidelity (alt-screen, mouse, bracketed paste, Cascadia)
- R3 — Graceful pty shutdown sequence (Ctrl+C twice dance vs force-kill)
- R4 — Resize propagation correctness under ConPTY
- R6 — React state management choice (affects ViewRouter + session map refactor)
- R11 — PATH handling for OSS users across install methods

Full details: `docs/research.md`.
