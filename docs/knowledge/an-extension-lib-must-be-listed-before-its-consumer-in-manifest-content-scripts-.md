---
type: learning
title: An extension lib must be listed before its consumer in manifest content_scripts — order IS load order
projectId: choda-deck
scope: project
refs:
  - path: extension/manifest.json
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/lib/noise-filter.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/lib/recorder.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/popup.html
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/background.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
createdAt: 2026-07-30
lastVerifiedAt: 2026-07-30
---

## Trigger

You add a new helper under `extension/lib/`, wire a content script to use it, and get
`ChodaSomething is not defined` — but only in the browser, never in the unit tests (which
`require()` the file directly and so can't see the ordering problem at all).

## Context

Choda Capture's content-script layer follows a one-lib-per-job convention
(`redact.js`, `selector.js`, `noise-filter.js`, `recorder.js`, `snapshot.js`), each written
in the **dual-mode** style: assign the API to `globalThis` for classic content-script loading
AND to `module.exports` for vitest. No `import`/`export` keywords — those would stop the file
parsing as a classic script.

`manifest.json`'s `content_scripts[].js` array is a **load-order list**, not a set. Each file
runs in sequence in the same isolated world, so a consumer reading `ChodaX` off the global
only works if `lib/x.js` appears **earlier in the array**. Nothing validates this: the
manifest loads fine, and the failure surfaces at first use as a bare ReferenceError.

## Business rule

- Pure logic goes in its own `extension/lib/*.js` with a colocated `.test.js` — not inline in
  `recorder.js` / `content.js` / `popup.js`. (Untested top-level extension code is where this
  project's bugs concentrate.)
- Every new lib must be inserted into `content_scripts[].js` **before** whatever consumes it.
- The same ordering discipline applies in the other two load contexts, which are separate
  lists that must be maintained independently:
  - **Side panel** — `<script src="lib/…">` tags in `popup.html`, before `popup.js`.
  - **Service worker** — `importScripts('lib/…')` at the top of `background.js`. Note the
    sharper failure mode here: a parse error or bad path in an `importScripts` target kills
    the **entire** service worker, so all capture stops, headers included — a worse outcome
    than the bug being fixed.

## Resolution

`noise-filter.js` (TASK-1423) is the reference case: listed before `recorder.js` in
`content_scripts`, because `recorder.js`'s `handleNetwork()` calls into it. Later libs follow
the same rule in their own context — `curl.js` / `netview.js` / `reqfilter.js` via
`popup.html` script tags, `correlate.js` via `background.js`'s `importScripts`.

When adding a lib, check which of the three lists needs the entry; it is easy to add the file
and the tests and forget the wiring entirely, in which case tests pass and the feature is dead
in the browser.
