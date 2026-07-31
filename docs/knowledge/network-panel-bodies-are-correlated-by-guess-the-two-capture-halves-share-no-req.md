---
type: learning
title: Network-panel bodies are correlated by guess — the two capture halves share no request id
projectId: choda-deck
scope: project
refs:
  - path: extension/lib/correlate.js
    commitSha: 8bac9bb175e4b75f222076128c151545666d4392
  - path: extension/background.js
    commitSha: 8bac9bb175e4b75f222076128c151545666d4392
  - path: extension/inject.js
    commitSha: 8bac9bb175e4b75f222076128c151545666d4392
  - path: extension/lib/recorder.js
    commitSha: 8bac9bb175e4b75f222076128c151545666d4392
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

Verified live (TASK-1547 AC-3): the same endpoint fired 3x concurrently, all three rows
matched their own request — the case unit tests could only simulate.

## What else webRequest cannot give you

The missing body is the well-known gap, but it is not the only one. `chrome.webRequest`
also exposes **no request-initiator stack** and **no per-phase timings**. That is why the
detail pane deliberately stops at Headers / Payload / Preview / Response / Cookies and has
no **Initiator** or **Timing** tab, even though Chrome DevTools shows both:

- **Initiator** needs the JS call stack that issued the request. webRequest reports only an
  `initiator` *origin* string, not the frame/stack DevTools renders.
- **Timing** needs DNS / connect / TLS / send / wait / receive breakdowns. webRequest gives
  a `timeStamp` per lifecycle event, which is not the same data and cannot be decomposed
  into phases after the fact.

Both would require attaching `chrome.debugger` — the same escalation that response bodies
were deliberately avoided with, because it shows the user a "started debugging this browser"
banner and conflicts with DevTools being open on the same tab.

**Rule: do not add a tab the data cannot fill.** An empty Initiator tab reads as a broken
feature; its absence reads as a scoped one. If either is genuinely needed, the decision to
take is "attach chrome.debugger", not "find a webRequest workaround" — there isn't one.
Note the HAR writer has the same constraint: `harEntry()` emits `time: -1` and
`timings: {send: -1, wait: -1, receive: -1}` because those are spec-mandated fields it
cannot honestly populate.

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
- Shipped in PR #224 (`59d8307`); live verification tracked by TASK-1547.
