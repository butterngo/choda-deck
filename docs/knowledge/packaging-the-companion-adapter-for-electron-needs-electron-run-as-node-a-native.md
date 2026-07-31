---
type: gotcha
title: Packaging the companion adapter for Electron needs ELECTRON_RUN_AS_NODE + a native-module rebuild
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-07-24
lastVerifiedAt: 2026-07-24
affectedFeatureId: feature-companion-cockpit
---

## Trigger

Spawning the vendored companion adapter (`src/adapters/companion/`, built to `dist/companion-server.cjs`) from an Electron main process, or vendoring its native dependencies into a packaged app, without two specific steps. Symptom seen on a real user install: "Choda Companion couldn't start — adapter exited during boot (code 0)", then after the first fix, `ERR_DLOPEN_FAILED... NODE_MODULE_VERSION mismatch`.

## Context

`choda-deck-companion`'s Electron shell (`electron/main.cjs`, `electron/adapter-launcher.cjs`) spawns the adapter as a child process using `process.execPath`. The adapter's native dependency (`better-sqlite3`) is vendored from the sibling `choda-deck` checkout (`scripts/vendor-adapter.mjs`) since it has zero presence in the companion repo otherwise.

## Business rule

1. **`process.execPath` inside a packaged Electron app IS the Electron binary, not plain Node.** Spawning it to run a script requires `ELECTRON_RUN_AS_NODE=1` in the child's env — without it, the "child" launches a second Electron instance instead of running the script, which exits cleanly (code 0) rather than booting anything.
2. **Any native (`.node`) dependency vendored into a packaged Electron app must be rebuilt against the pinned Electron version's ABI**, not copied as-is from a plain-Node build — the host Node build's `NODE_MODULE_VERSION` differs from Electron's bundled Node, and loading it throws `ERR_DLOPEN_FAILED`.
3. **electron-builder's `extraResources` file-matcher silently drops any nested `node_modules` directory** from the packaged output — a vendored native dependency must live under a differently-named directory (this repo uses `deps`), even though the rebuild tooling (`@electron/rebuild`'s `--module-dir`) requires a real `node_modules`-shaped layout to operate on.

## Resolution

- `adapter-launcher.cjs`'s `spawnAdapter` sets `ELECTRON_RUN_AS_NODE: '1'` unconditionally in the spawned adapter's env.
- `scripts/vendor-adapter.mjs` stages vendored deps under a literal `node_modules` folder (for `@electron/rebuild --module-dir`), runs the rebuild against the currently-pinned Electron version, then renames that folder to `deps` before electron-builder packages it.
- Electron is pinned to `^34.0.0` in this repo — the originally-tried `42.x` had no working from-source rebuild path for `better-sqlite3` in this environment's toolchain (real `v8::External` API compile errors), and `better-sqlite3` ships no Electron-specific prebuilt binaries at all (a from-source rebuild is always required, by design).

## Related

- `electron/adapter-launcher.cjs`, `electron/adapter-launcher.test.cjs`, `scripts/vendor-adapter.mjs` (choda-deck-companion)
- TASK-1437 (Electron shell), TASK-1438 (packaging), TASK-1464 (this fix)
