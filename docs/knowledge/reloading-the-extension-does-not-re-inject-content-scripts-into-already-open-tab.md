---
type: learning
title: Reloading the extension does not re-inject content scripts into already-open tabs
projectId: choda-deck
scope: project
refs:
  - path: extension/content.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/background.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/manifest.json
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/popup.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
createdAt: 2026-07-30
lastVerifiedAt: 2026-07-30
---

## Trigger

You reload the unpacked extension at `chrome://extensions`, then use the Network panel on a
tab that was **already open**. Rows appear with method, status and full headers — but never a
body. Looks exactly like a broken body-capture code path, and sends you debugging the wrong
half.

## Context

Chrome injects `content_scripts` (including `world: "MAIN"` entries) at document load only.
Reloading the extension restarts the service worker but does **not** re-run content scripts
in existing tabs. The two halves of Choda Capture then disagree:

- `background.js`'s `chrome.webRequest` listeners are re-registered with the new SW and keep
  recording headers for every tab, old or new.
- `inject.js`'s `fetch`/XHR patch is **gone** from the pre-reload tab — that document is
  still running the world it loaded with.

Result: complete-looking rows with a permanent hole where the body should be. The failure is
indistinguishable from "this response genuinely had no text body" unless something tracks
whether an interceptor is live in that tab.

## Business rule

Any capture feature spanning a content script and the service worker must be able to answer
"is my content script actually alive in this tab?" — otherwise a stale-injection state is
misreported as a data problem, and the UI tells the user to retry an operation that cannot
ever succeed.

## Resolution

- `content.js` sends `{ type: 'relayReady' }` on load; `background.js` records the tab in
  `instrumentedTabs`.
- A relayed body also re-marks the tab, so a service-worker restart (which clears the Set)
  self-heals on the next captured request instead of producing a false negative.
- `getRequests` returns `instrumented`, and the panel's body tabs then distinguish:
  - not instrumented → `(capture not active in this tab — reload the PAGE, then ⟳ Refresh)`
  - instrumented → `(no body captured — a non-text response, or one the page never read)`

**Operationally: reload the extension AND the page, in that order.** Extension-only reload is
the trap.

## Note

The flag is a *soft* signal — it lives in SW memory, so it is lost on SW teardown and briefly
under-reports until the next relay. It is worded as a suggestion in the UI for exactly that
reason, never as a definitive "capture is off".

## Related

- Same class of constraint as the repeatedly-noted "live in-browser verification can't be
  driven headlessly" (TASK-1410 / 1423 / 1424 handoffs) — the extension's runtime state is
  not reachable from the test suite, so this had to be made visible in the UI instead.
- See also: `network-panel-bodies-are-correlated-by-guess-the-two-capture-halves-share-no-req`
  — the other reason a body can be missing, which this signal now disambiguates from.
