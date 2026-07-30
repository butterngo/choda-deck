---
type: learning
title: Network-panel bodies are correlated by guess — the two capture halves share no request id
projectId: choda-deck
scope: project
refs:
  - path: extension/lib/correlate.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/background.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/inject.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/lib/recorder.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
createdAt: 2026-07-30
lastVerifiedAt: 2026-07-30
---

## Trigger

A row in the extension's Network panel shows headers and a status but `(no body captured)`,
or — worse and silently — shows a body that belongs to a *different* request. Most likely
on a page that fires the same endpoint concurrently (paging, refetch-on-focus, RSC).

## Context

Choda Capture's Network panel assembles each row from **two sources that share no key**:

| Source | Has | Missing |
|---|---|---|
| `chrome.webRequest` (`background.js`) | requestId, method, url, status, headers, cookies | **any body** (needs `chrome.debugger`) |
| MAIN-world `fetch`/XHR patch (`inject.js`) | request + response body | **Chrome's requestId** |

Records are keyed by request *start*; bodies arrive on *completion*. So the SW has to graft
a body onto a record by inference. There is no id to join on, and there cannot be one
without either attaching `chrome.debugger` or injecting a correlation header into the page's
own requests (which would trigger CORS preflight — rejected).

## Business rule

Correlate on `(url, method, call-time)` with a bounded skew, and **never** on
"the newest record that lacks a body". Newest-first mis-routes every concurrent duplicate:
the first response to land claims the newest record, shifting the rest and stranding the
oldest permanently empty. Prefer dropping a body over attaching it to the wrong request —
wrong data reads as truth.

## Resolution

`extension/lib/correlate.js` owns `pickRecordForBody()`:

- `inject.js` stamps `Date.now()` at **call** time (not completion) for both `fetch` and
  `XHR.send`; `content.js` relays it as `startedAt`.
- The candidate whose webRequest `ts` is nearest that stamp wins — same epoch clock on both
  sides, so they compare directly.
- Beyond `MAX_SKEW_MS` (5s) it returns `null` rather than attaching to an unrelated call.
- No stamp (older relay path) falls back to the **oldest** unclaimed record — FIFO, which
  cannot strand the first request forever.
- When two calls start in the same millisecond, pairing is ambiguous by construction. The
  invariant that still holds: every body lands somewhere and no record is left empty.

## Note — the discovery recorder does not have this problem

`lib/recorder.js:handleNetwork()` consumes the interceptor's message **directly** off
`window.postMessage` and emits an `apicall` event carrying `body` + `reqBody`. No webRequest,
no service worker, no correlation step. The body cannot get lost because it never leaves the
object that carried it. Only the panel pays the correlation cost — so when comparing "the
recorder captured this but the panel didn't", that asymmetry is the reason, not a regression.

## Related

- Request bodies existed in `inject.js` since TASK-1424 but were **discarded** by
  `attachBody` until the detail-tabs change — only the discovery path consumed them.
- Coverage: `extension/lib/correlate.test.js` (unit) + `extension/inject.test.js`
  (interceptor → message → correlation, incl. out-of-order completion).
