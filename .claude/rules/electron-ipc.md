---
paths:
  - "src/main/**/*.ts"
  - "src/preload/**/*.ts"
  - "src/renderer/**/*.ts"
  - "src/renderer/**/*.tsx"
---

# Electron IPC conventions — Choda Deck

These rules are extracted from `src/main/index.ts` and `src/preload/index.ts`. Follow them exactly when adding new IPC surface — inconsistency here is the fastest way to break session isolation.

## Channel naming

`<namespace>:<verb>` for commands, `<namespace>:<verb>:<scopeId>` for per-scope event streams.

Existing channels:

| Channel | Kind | Purpose |
|---|---|---|
| `pty:spawn` | invoke (request/response) | Start a new pty session in a given cwd |
| `pty:input` | send (fire-and-forget) | Write user keystrokes into a live pty |
| `pty:resize` | send | Propagate cols/rows from xterm to pty |
| `pty:kill` | send | Terminate a pty on user request |
| `pty:data:${id}` | on (stream) | Bytes from pty stdout/stderr to renderer |
| `pty:exit:${id}` | on (event) | Pty exited with code |

Rules:
- **Namespace is lowercase, single word** (`pty`, `project`, `task`, `vault`). Not kebab, not camelCase.
- **Verb describes the action from the renderer's POV** (it's the caller): `spawn`, `input`, `resize`, `kill`, `data`, `exit`.
- **Per-session event streams suffix the session id**: `pty:data:${id}`. One channel per session prevents cross-session data fan-out at the IPC layer and keeps listener cleanup scoped.
- **Request/response pairs do NOT suffix the id** — the id goes in the payload. Only streams get the suffixed channel.

## invoke vs send vs on

| Kind | Renderer side | Main side | Use for |
|---|---|---|---|
| **invoke** | `ipcRenderer.invoke(channel, ...args)` → `Promise<R>` | `ipcMain.handle(channel, handler)` | Request/response that the renderer needs to await |
| **send** | `ipcRenderer.send(channel, ...args)` | `ipcMain.on(channel, handler)` | Fire-and-forget commands where a response is not needed |
| **on** (stream) | `ipcRenderer.on(channel, listener)` | `webContents.send(channel, ...args)` | Data streams pushed from main to renderer |

Rules:
- **`spawn` uses invoke** (returns `{ ok, id }`) — the renderer needs to know whether the session was created before attaching listeners.
- **`input`, `resize`, `kill` use send** — no meaningful response; the renderer cannot do anything useful if they fail mid-flight except log.
- **`data` and `exit` use on/send stream** — pushed from main.
- Do NOT mix kinds for one channel. A channel is always one kind.

## Preload surface (contextBridge)

**The preload script is the only boundary** between renderer and main. Renderer has `contextIsolation: true` and no direct `require`, `process`, or `ipcRenderer` access.

From `src/preload/index.ts`:

```ts
contextBridge.exposeInMainWorld('electron', electronAPI)
contextBridge.exposeInMainWorld('api', api)
```

Two globals are exposed:
- `window.electron` — `@electron-toolkit/preload` standard utilities (process info, IPC raw)
- `window.api` — **the Choda-Deck-specific surface**. All new project-specific IPC goes here.

Rules:
- **All new renderer-visible IPC must go through `window.api`.** Do not expose new globals.
- **Organize by feature namespace**: `window.api.pty.*`, `window.api.project.*`, `window.api.task.*`. Do not flatten.
- **Type every method explicitly** with return type — `window.api` is the public boundary, implicit returns hide contract drift. See existing style:
  ```ts
  spawn: (id: string, cwd: string, cols: number, rows: number): Promise<{ ok: boolean; id: string }> =>
    ipcRenderer.invoke('pty:spawn', id, cwd, cols, rows)
  ```
- **Stream subscribe methods return a cleanup function** — see `onData` / `onExit` pattern:
  ```ts
  onData: (id: string, callback: (data: string) => void): (() => void) => {
    const channel = `pty:data:${id}`
    const listener = (_event: IpcRendererEvent, data: string): void => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
  ```
  The returned cleanup MUST be called by the renderer (typically in useEffect return). Never attach a listener without returning its cleanup.

## Preload type definitions

- Renderer sees `window.api` via type declarations in `src/preload/index.d.ts`.
- Any new method added to `window.api` in `index.ts` must ALSO be added to `index.d.ts`. Missing = silent `any` in renderer.

## What belongs in main vs preload vs renderer

| Layer | Allowed | Forbidden |
|---|---|---|
| **main** | Node APIs, node-pty, fs, path, process env, IPC handlers, session state | React, DOM, xterm |
| **preload** | contextBridge, ipcRenderer, thin wrappers | Business logic, state, side effects beyond event subscribe |
| **renderer** | React, DOM, xterm.js, `window.api` | `require`, `process`, `ipcRenderer` direct, Node APIs, fs |

The preload script is deliberately thin — it **defines the IPC contract** and nothing else. Business logic lives in main or renderer, not in preload.

## Security

- `contextIsolation: true` — stays on. Do not disable.
- `sandbox: false` — required for preload Node APIs (node-pty imports). Do not enable.
- `nodeIntegration` — not set, stays default (off). Do not enable.
- Before adding any new IPC handler in main, ask: can the renderer achieve this with existing APIs? New IPC surface is new attack surface.

## Error handling across IPC

- **invoke handlers** may throw — the renderer's await will reject. Use this for genuinely exceptional cases.
- **send handlers** have nowhere to report errors — guard internally and log to main console. Do not throw.
- **Per-session channels are cleaned up on session exit** — the main-side handler deletes from `sessions` map in `onExit`. Mirror this on the renderer side in effect cleanup.

## When extending IPC

Checklist when adding a new channel:
1. Name it per the rule above
2. Pick invoke / send / on — one kind only
3. Add a handler in `src/main/index.ts` inside `app.whenReady()`
4. Add the wrapper in `src/preload/index.ts` under the right namespace
5. Update type defs in `src/preload/index.d.ts`
6. For streams: return cleanup from the wrapper; renderer must call it
7. Document the channel in `docs/architecture.md` → IPC contract table
