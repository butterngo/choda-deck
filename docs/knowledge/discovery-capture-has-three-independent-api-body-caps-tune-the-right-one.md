---
type: learning
title: Discovery capture has three independent API-body caps — tune the right one
projectId: choda-deck
scope: project
refs:
  - path: extension/inject.js
    commitSha: 49838f24becaf1785b8d92f9f4b1411092a414fd
  - path: extension/lib/recorder.js
    commitSha: 49838f24becaf1785b8d92f9f4b1411092a414fd
  - path: src/adapters/companion/discovery-artifacts.ts
    commitSha: 49838f24becaf1785b8d92f9f4b1411092a414fd
  - path: src/adapters/companion/capture-contract.ts
    commitSha: 49838f24becaf1785b8d92f9f4b1411092a414fd
createdAt: 2026-07-22
lastVerifiedAt: 2026-07-22
---

## Context

The discovery-session capture pipeline (extension → companion) touches an
apicall's request/response body at three separate layers, each with its own
cap, before it lands in `timeline.jsonl`:

1. **`extension/inject.js`** (MAIN world) — relays the raw fetch/XHR body via
   `postMessage`, capped at 64 KB (`MAX`). This is the first truncation point;
   anything cut here is gone for good.
2. **`extension/lib/recorder.js`** — redacts (`ChodaRedact.redactText`) and
   re-caps to `MAX_API_BODY` (64 KB) before emitting the `apicall` event.
3. **`src/adapters/companion/discovery-artifacts.ts`** — on write, any `body`
   over `INLINE_BODY_CAP` (32 KB) is spilled to `bodies/<n>-res.txt` under the
   session dir and replaced with a `bodyPath` reference; the JSONL line itself
   stays lean.

Before TASK-1424, layer 1 capped at 20 KB and layer 2 at 8 KB — the 8 KB cap
was the one actually truncating real payloads mid-structure (INBOX-1172).
Raising 1+2 to 64 KB removed the truncation; layer 3's 32 KB spill threshold
is intentionally lower than the extension caps, so a 40 KB body still moves
to a file even though it would have fit inline at the old extension cap —
that's by design, to keep `timeline.jsonl` scannable.

## Business rule

When a captured body looks truncated or missing, check **all three** caps in
capture order (inject.js → recorder.js → discovery-artifacts.ts), not just
the one closest to where the symptom is observed. A fix at one layer can be
silently undone by a tighter cap upstream or downstream.

Separately: **request-body capture (`reqBody`) only handles the string-body
case** — i.e. `typeof init.body === 'string'` for `fetch`, or a string arg to
`XMLHttpRequest.send()`. This covers the common `JSON.stringify(...)`
convention. `FormData`, `Blob`, `ReadableStream`, and other non-string bodies
are **silently skipped**, not guessed at or partially serialized — a POST
using `FormData` will show no `reqBody` at all, which is expected, not a bug.

## Resolution

TASK-1424 raised the extension-side caps from 8/20 KB to 64 KB and added a
32 KB companion-side spill-to-file for response bodies (`bodyPath`), plus
string-only request-body capture into `reqBody`. If a future task needs
non-string request bodies (FormData uploads, etc.), that's new scope, not an
extension of the existing string-only path.
