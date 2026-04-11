# Choda Deck — Preload (context bridge)

## Purpose

The **only** boundary between the sandboxed renderer and the Node-capable main process. This layer defines `window.api` — the complete IPC contract the renderer can see. It is deliberately thin: no business logic, no state, no side effects beyond event subscription plumbing.

## What belongs here

- `contextBridge.exposeInMainWorld('api', api)` — the public surface for the renderer
- Thin wrappers over `ipcRenderer.invoke`, `ipcRenderer.send`, `ipcRenderer.on`
- Type definitions for the `api` object (duplicated in `index.d.ts` for renderer TypeScript resolution)
- Cleanup-returning wrappers for event streams (see `onData` / `onExit` pattern)

## What does NOT belong here

- Business logic of any kind — put it in main or renderer
- State (variables held beyond method scope)
- Direct DOM / React access
- Heavy computation — preload runs on every window load; bloat = slow startup
- New globals other than `electron` and `api` — do not `exposeInMainWorld` a third name

## Key types / entry points

- `api.pty.*` — session lifecycle and IPC streams. Matches channel names in `src/main/index.ts` one-to-one.
- `api.spike.*` — **temporary** surface for the hardcoded spike project. Delete the whole namespace when the real config loader lands in main.
- `SpikeProject` interface (exported for renderer consumption) — colocated with the spike namespace. Delete together.
- `contextBridge.exposeInMainWorld` is called only if `process.contextIsolated`. The `else` branch writes directly to `window` — `// @ts-ignore` on those lines is intentional for the non-isolated fallback; do not add new globals in the fallback branch without a corresponding isolated-mode exposure.

## Layer-specific rules

- **Every wrapper method has an explicit return type.** The preload surface is the public contract — implicit returns hide drift. Follow the existing style exactly.
- **Stream subscribers return their own cleanup.** Any method that calls `ipcRenderer.on` must return `() => ipcRenderer.removeListener(...)`. Never attach a listener without returning cleanup.
- **Per-session channels are built by string interpolation**: `` `pty:data:${id}` ``. Keep the channel-naming scheme aligned with main — if you rename here without renaming main, messages disappear silently.
- **Keep `index.ts` and `index.d.ts` in sync.** Adding a method to one without the other means the renderer sees `any` (or worse, a TypeScript error depending on strict mode). Always edit both.
- **No imports from `../main` or `../renderer`.** Preload has its own module boundary. Types may be duplicated across layers rather than imported — that is intentional isolation.
- **Do not await inside wrapper bodies except to forward the promise.** `invoke` returns a Promise; the wrapper should just `return ipcRenderer.invoke(...)`, not `const r = await ...; return r`.
- **Do not log here.** `console.error` is reserved for the one catch block around contextBridge exposure, which handles an unrecoverable setup failure.

## Naming

Namespace new surface under a feature name: `api.workspace.*`, `api.project.*`, `api.window.*`. Do not flatten methods onto `api` directly, and do not create single-letter namespaces.

## When extending the preload surface

1. Add the channel in `src/main/index.ts` first (the handler is the source of truth).
2. Add the wrapper here with an explicit return type.
3. Update `src/preload/index.d.ts` with the same signature.
4. Update `docs/architecture.md` → IPC contract table.
5. Renderer changes come last.
