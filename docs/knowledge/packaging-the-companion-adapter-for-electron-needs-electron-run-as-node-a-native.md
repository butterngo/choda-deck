---
type: gotcha
title: Packaging the companion adapter for Electron needs ELECTRON_RUN_AS_NODE + a native-module rebuild
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-07-24
lastVerifiedAt: 2026-09-07
affectedFeatureId: feature-companion-cockpit
---

## Trigger

Spawning the vendored companion adapter (`src/adapters/companion/`, built to `dist/companion-server.cjs`) from an Electron main process, or vendoring its native dependencies into a packaged app, without the steps below. Symptoms seen on real installs: "Choda Companion couldn't start — adapter exited during boot (code 0)", then after the first fix, `ERR_DLOPEN_FAILED... NODE_MODULE_VERSION mismatch`.

Also: **an `electron-rebuild` you believed was mandatory dies at gyp configure** and you assume the staged tree is wrong. See rule 2 — it may not need rebuilding at all.

> **Note on the title.** "a native-module rebuild" is accurate for `better-sqlite3`, which is what this entry was written about (TASK-1464). It is **not** a general rule — rule 2 below carries the actual boundary. The title is immutable, so it is qualified here instead.

## Context

`choda-deck-companion`'s Electron shell (`electron/main.cjs`, `electron/adapter-launcher.cjs`) spawns the adapter as a child process using `process.execPath`. Its native dependencies are vendored from the sibling `choda-deck` checkout (`scripts/vendor-adapter.mjs`), since they have zero presence in the companion repo otherwise.

Two native modules now ship this way, and **they need opposite treatment** — `better-sqlite3` (TASK-1464) and `node-pty` (TASK-1878).

## Business rule

1. **`process.execPath` inside a packaged Electron app IS the Electron binary, not plain Node.** Spawning it to run a script requires `ELECTRON_RUN_AS_NODE=1` in the child's env — without it, the "child" launches a second Electron instance instead of running the script, which exits cleanly (code 0) rather than booting anything.

2. **Whether a vendored `.node` dependency must be rebuilt is decided by its ABI, not by the fact that it is native.**

   - **V8/NAN addons** — e.g. `better-sqlite3` — compile against the *host Node build's* `NODE_MODULE_VERSION`, which differs from Electron's bundled Node. Copied as-is they throw `ERR_DLOPEN_FAILED`, so they **must** be rebuilt against the pinned Electron version's ABI. `better-sqlite3` ships no Electron-specific prebuilt binaries at all; a from-source rebuild is always required, by design.
   - **N-API addons** — e.g. `node-pty`, via `node-addon-api` — compile against an ABI that is stable **across Node versions and across Electron by design**. Their shipped `prebuilds/<platform>-<arch>/*.node` load unchanged. Rebuilding them is unnecessary, and adding them to `NATIVE_MODULES_TO_REBUILD` is an active mistake.

   For `node-pty` the rebuild is not merely unnecessary but **impossible**: the published tarball omits `deps/winpty/src/shared/GetCommitHash.bat`, so gyp dies at configure with `'GetCommitHash.bat' is not recognized`. A first attempt also required staging `node-addon-api`, because `binding.gyp` shells out to it during configure — a dependency no manifest would suggest, and which stopped being needed once the rebuild was dropped.

   **How to tell before you try:** `dependencies` containing `node-addon-api`, or the presence of a `prebuilds/` directory, means N-API — vendor it, do not rebuild it. `node-pty`'s `lib/utils.js` falls back to `prebuilds/` when `build/Release` is absent, which after a no-rebuild vendor is exactly the case.

3. **electron-builder's `extraResources` file-matcher silently drops any nested `node_modules` directory** from the packaged output — a vendored native dependency must live under a differently-named directory (this repo uses `deps`), even though the rebuild tooling (`@electron/rebuild`'s `--module-dir`) requires a real `node_modules`-shaped layout to operate on.

## Resolution

- `adapter-launcher.cjs`'s `spawnAdapter` sets `ELECTRON_RUN_AS_NODE: '1'` unconditionally in the spawned adapter's env.
- `scripts/vendor-adapter.mjs` stages vendored deps under a literal `node_modules` folder (for `@electron/rebuild --module-dir`), rebuilds **only the modules in `NATIVE_MODULES_TO_REBUILD`** against the pinned Electron version, then renames that folder to `deps` before electron-builder packages it. `node-pty` is in `VENDORED_DEPS` and deliberately **not** in the rebuild list; the reason sits above the constant so the next reader meets the measurement rather than repeating the experiment.
- `scripts/vendor-pty.test.mjs` pins that shape so it cannot quietly revert.
- Electron is pinned to `^34.0.0` — the originally-tried `42.x` had no working from-source rebuild path for `better-sqlite3` in this environment's toolchain (real `v8::External` API compile errors).

**Verify by loading, not by reasoning.** For either kind of module, run the *shipped* Electron binary with `ELECTRON_RUN_AS_NODE=1`, put the vendored `deps` tree on `module.paths`, and `require` the module **by bare name** — the same resolution the packaged bundle uses via `NODE_PATH`. It either works or it does not.

Done for `node-pty` at 0.12.0: the shipped copy, under the shipped Electron binary, from `release/win-unpacked/resources/adapter`, spawned a real shell — `ok=true exit=0`.

## Related

- `electron/adapter-launcher.cjs`, `electron/adapter-launcher.test.cjs`, `scripts/vendor-adapter.mjs`, `scripts/vendor-pty.test.mjs` (choda-deck-companion)
- TASK-1437 (Electron shell), TASK-1438 (packaging), TASK-1464 (`ELECTRON_RUN_AS_NODE` + the `better-sqlite3` rebuild), TASK-1878 (`node-pty`, and the ABI distinction)
- TASK-1888 — the acceptance criterion this finding invalidated, left unticked rather than reworded to match what was built
- Verify a vendored bundle at the packaged path, not the staging directory
