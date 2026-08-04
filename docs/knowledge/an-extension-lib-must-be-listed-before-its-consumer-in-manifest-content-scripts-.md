---
type: learning
title: An extension lib must be listed before its consumer in manifest content_scripts — order IS load order
projectId: choda-deck
scope: project
refs:
  - path: extension/manifest.json
    commitSha: c936434814688c3e45d842a1dc4bd2e9f353b367
  - path: extension/lib/noise-filter.js
    commitSha: c936434814688c3e45d842a1dc4bd2e9f353b367
  - path: extension/lib/recorder.js
    commitSha: c936434814688c3e45d842a1dc4bd2e9f353b367
  - path: extension/popup.html
    commitSha: c936434814688c3e45d842a1dc4bd2e9f353b367
  - path: extension/background.js
    commitSha: c936434814688c3e45d842a1dc4bd2e9f353b367
  - path: extension/popup-wiring.test.js
    commitSha: c936434814688c3e45d842a1dc4bd2e9f353b367
createdAt: 2026-07-30
lastVerifiedAt: 2026-08-04
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

## Confirmed instance — and why the note alone was not enough (2026-08-04, TASK-1559)

The paragraph above predicted a real defect five days before it shipped, and did not prevent
it. `8d09033` (TASK-1555) added the element picker: `popup.js` calls `ChodaPicker.formatPick()`
to render the artifact and `ChodaPicker.cropRect()` to build the screenshot crop — both in the
**side panel**, not the page — while `popup.html` never gained the `<script src="lib/picker.js">`
tag. The whole element-capture path was dead from the day it shipped until 2026-08-04.

Two silences hid it, and both are worth copying as anti-patterns:

- `formatPick()` was called **outside any `try`**, so the async click handler rejected and
  Capture → changed nothing at all — no error, no status, a button that looked merely inert.
- `cropRect()` sat inside a bare `catch {}` justified as "no crop — the pick still carries
  selector, styles and HTML". Legitimate degradation, but it meant **no element screenshot was
  ever produced** and nothing ever said so.

The realm distinction is what makes this trap sharper than the manifest case: `picker.js` WAS
being loaded — into the page, via `chrome.scripting.executeScript`. `globalThis.ChodaPicker`
resolved fine there. The same identifier in the panel resolved to `undefined`. One name, two
realms, one of them wired.

**The fix that matters is not the script tag — it is `extension/popup-wiring.test.js`.** It
parses `popup.html` for its script list, executes those libs in order in a bare VM, and asserts
every `Choda*` global that `popup.js` references **in the panel's own realm** resolves. It
deliberately excludes `globalThis.ChodaPicker`, since that reference executes in the page. No
DOM, no fixture, ~210ms. Proven to discriminate: with the two script tags removed it fails
naming `ChodaPicker` exactly.

Standing lesson: when a documented discipline gets violated anyway, the answer is a mechanical
guard, not a firmer note. This entry was correct and ignored; the test cannot be.
