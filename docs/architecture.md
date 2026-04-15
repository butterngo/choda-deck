# Architecture — Choda Deck

## Overview

Electron-based desktop application with three standard processes — main (Node.js), preload (context bridge), renderer (React). The unique piece is the PTY layer: each project tab hosts a live `node-pty` process spawned in that project's cwd, piped bidirectionally through IPC into an `xterm.js` instance in the renderer. Session state lives in the main process (process handles + IPC event streams); the renderer only holds the visual terminal and forwards user input.

Architecture style: **process-isolated, IPC-mediated, session-as-entity**. The unit of state is a `Session` (one pty + one xterm instance + one project cwd).

## Layers / Components

| Component | Role |
|---|---|
| `src/main/index.ts` | Main process. Electron lifecycle, BrowserWindow, PTY session map, IPC handlers |
| `src/preload/index.ts` | Preload script. Exposes `window.api.pty.{spawn,input,resize,kill,onData,onExit}` via contextBridge |
| `src/renderer/src/App.tsx` | Renderer orchestrator. Holds project list + active ID, keyboard shortcuts |
| `src/renderer/src/Sidebar.tsx` | Project sidebar. Add/remove projects, help overlay |
| `src/renderer/src/TerminalView.tsx` | Per-project terminal. xterm.js + FitAddon + restart banner |
| `src/graph/graph-types.ts` | Graph types: NodeType, RelationType, GraphNode, GraphEdge, buildUid() |
| `src/graph/graph-service.interface.ts` | GraphService interface — provider-agnostic contract |
| `src/graph/neo4j-graph-service.ts` | Neo4j implementation of GraphService |
| `src/graph/vault-parser.ts` | Parse vault markdown → JSON (nodes + edges) |
| `src/graph/neo4j-import.ts` | Import vault-graph.json → Neo4j (idempotent MERGE) |
| `src/graph/graph-cli.ts` | CLI for graph queries + workspace management |
| `src/graph/mcp-graph-server.ts` | MCP server — 5 graph tools for Claude sessions |
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
| `ProjectConfig` (preload type) | `{ id, name, workspaces: WorkspaceConfig[] }` loaded from `projects.json` |
| `WorkspaceConfig` (preload type) | `{ id, label, cwd, shell? }` — per-project terminal config |

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
| `vault:tree` | invoke | R→M | `(rootPath)` → `FileNode[]` |
| `vault:read` | invoke | R→M | `(filePath)` → `{ content, size, mtime }` |
| `vault:search` | invoke | R→M | `(query, rootPath)` → `SearchResult[]` |
| `vault:resolve` | invoke | R→M | `(wikilink, rootPath)` → `string \| null` |
| `vault:contentRoot` | invoke | R→M | `()` → `string` |
| `project:list` | invoke | R→M | `()` → `ProjectConfig[]` |
| `project:add` | invoke | R→M | `(id, cwd)` → `{ ok, error?, project? }` |
| `project:remove` | invoke | R→M | `(id)` → `{ ok, error? }` |

## Quality attributes

| Attribute | How it is ensured |
|---|---|
| Responsiveness | xterm.js renders direct on canvas; IPC batches data chunks; FitAddon debounce (50ms) |
| Session persistence | Sessions live in main process `Map`; xterm instances mounted once in renderer, never disposed on tab switch |
| Graceful shutdown | `window-all-closed` sends Ctrl+C, waits 2s, then force kills. Sessions cleaned up before `app.quit()` |
| Crash resilience | Per-tab state machine `idle | running | exited-ok | crashed`; banner + manual restart button on failure |
| Cross-environment reliability | PATH augmented at startup with common CLI install dirs (npm global, homebrew, etc.) |
| Security | `contextIsolation: true`, `sandbox: false` (required for preload Node APIs); renderer has no direct Node access, only `window.api` surface |

## Graph layer

Data flow:

```text
vault (.md files)
  → vault-parser.ts → vault-graph.json (nodes + edges)
  → neo4j-import.ts → Neo4j (idempotent MERGE)
  → Neo4jGraphService (implements GraphService interface)
  → Consumers: CLI, MCP server, future UI
```

Design: files = content store, Neo4j = relationship store. GraphService interface abstracts the backend — consumers code to interface, not implementation. SQLite backend can be added by implementing the same interface.

UID scheme: `{type}:{project}/{id}` (e.g. `task:task-management/TASK-130`)

Node types: Task, Feature, Decision, Project.
Relation types: DependsOn, Blocks, PartOf, RelatesTo, Implements, DecidedBy.

### Known limitations (Phase 1)

- One-way sync only (vault → graph). No file → graph watcher yet (TASK-207)
- No UI for graph — CLI + MCP only
- No SQLite implementation yet
- Content search is title-match only, no full-text index
- 2 duplicate ADR UIDs in vault data (ADR-010, ADR-011 each have 2 files)

## Architectural note — polymorphic view container (MVP target, not yet implemented)

Main pane must be a **polymorphic view container**, not hardcoded single xterm. `<ProjectWorkspace>` hosts `<ViewRouter>` choosing between registered view types. MVP implements `terminal`; V2+ adds `note`, `tasks`, `adr`, `memory`, `graph` without rewriting the shell. Current `App.tsx` is a single-terminal spike — to be refactored during MVP build.

## Open research questions affecting architecture

- R1 — xterm.js TUI fidelity (alt-screen, mouse, bracketed paste, Cascadia)
- R3 — Graceful pty shutdown sequence (Ctrl+C twice dance vs force-kill)
- R4 — Resize propagation correctness under ConPTY
- R6 — React state management choice (affects ViewRouter + session map refactor)
- R11 — PATH handling for OSS users across install methods
