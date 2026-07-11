---
type: decision
title: "ADR-036: Companion capture bridge — token-gated POST /capture on the loopback companion adapter, direct in-process dispatch (no renderer-forward)"
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/http-server.ts
  - path: src/adapters/companion/capture-contract.ts
  - path: src/adapters/companion/bridge-token.ts
  - path: src/adapters/companion/service-factory.ts
createdAt: 2026-07-11
lastVerifiedAt: 2026-07-11
---

# ADR-036: Companion capture bridge — token-gated POST /capture on the loopback companion adapter

> AI-Context: The browser companion (TASK-1329) captures page content — selected text, a screenshot region, or a network artifact (headers/cookies/token, NOT response body in v1) — and routes it into choda-deck as an inbox item, task, conversation, or knowledge entry. The capture surface is `POST /capture` added to the EXISTING companion loopback adapter (`src/adapters/companion`, 127.0.0.1:7338), not a new server. It reuses english-companion's ADR-007 loopback-bridge pattern (loopback bind + per-profile token, MV3 service-worker owns the fetch) with ONE deliberate divergence: choda-deck has no Electron renderer, so the route dispatches to the in-process SQLite service directly — no renderer-forward. Skeleton (TASK-1330) ships transport + `x-choda-bridge-token` auth + contract validation + 501-until-dispatched; the dispatcher onto inbox/task/conversation/knowledge is TASK-1331.

## Context

The eJOY-style english-companion extension proved a loopback bridge (ADR-007): the extension's MV3 service worker POSTs to an HTTP server on `127.0.0.1`, gated by a per-profile random token. choda-deck wants the same capture ergonomics but pointed at its own domain — turn "this page / this selection / this API response" into an inbox item, task, conversation turn, or knowledge entry.

Two facts shaped the design:

1. **A loopback adapter already exists.** `src/adapters/companion` (TASK-1158) is a plain-Node HTTP server bound to `127.0.0.1` only, booting the core services over the laptop's local SQLite source of truth (full tool surface, local trust). It already serves read endpoints + sync actions. The capture surface belongs here, not in a second server.

2. **choda-deck has no renderer.** ADR-007's bridge forwards each request over IPC to an Electron renderer because that's where the Claude API key and vocab stores live. choda-deck's companion adapter already holds a `BackendTaskService` in-process — so a captured payload can be dispatched straight onto `inbox_add` / `task_create` / `conversation_*` / `knowledge_create` with no forward hop.

## Decision

1. **Route, not a new process.** `POST /capture` is added to `companion/http-server.ts`. It shares the adapter's hard-coded `127.0.0.1` bind (`COMPANION_BIND`, never env-driven) and its lifecycle.

2. **Token gate on the write path.** The existing read/sync endpoints rely on the loopback bind alone. `/capture` performs *writes triggered from a web page*, and a loopback bind does NOT stop a malicious page's `fetch` to `localhost` — CORS blocks reading the response, but a simple request's side effect still lands. So `/capture` requires `x-choda-bridge-token`, compared in constant time against a 24-byte base64url per-profile token persisted at `<dataDir>/bridge-token.txt` (mode 600). A page cannot read the token off disk; that is the real gate (identical threat model to ADR-007 §3). Mismatch/absent → 401.

3. **Contract, validated before dispatch.** Body = `{ kind: 'text'|'image'|'network', destination: 'inbox'|'task'|'conversation'|'knowledge', payload, sourceUrl }` (`capture-contract.ts`). Malformed → 400 with a specific message; non-JSON content-type → 415; body over the 64 KB cap → 413. The validator does NOT check per-kind payload shape — that is the dispatcher's job once the kind is known.

4. **Dispatch is an injected port (Open/Closed).** `CaptureDispatcher` is a one-method interface on `CompanionServices.dispatch?`. The skeleton wires none, so a well-formed capture returns **501** (distinct from a 400) — the request was valid, nothing routes it yet. TASK-1331 implements the dispatcher; a recognized-but-unwired destination throws `UnimplementedDestinationError` → also 501. Growing the surface never edits the route.

5. **Sync boundary (documented, enforced downstream).** inbox + task captures ride the existing `CHODA_BACKEND=sync` write-through loop to the remote automatically. conversation + knowledge are **local-only by design** (conversation_* gated per TASK-1067; knowledge_* not in the write-through path). This bridge does NOT widen sync scope. TASK-1332 additionally restricts image/network kinds to conversation|knowledge so captured secrets (cookies/tokens) never leave the laptop.

## Consequences

- No new binary or port: `build:companion` already produces `companion-server.cjs`; the capture surface ships inside it. App not running → connection refused; the extension owns that UX.
- The token file is a new secret on disk. It is per-profile and mode 600, not committed, and referenced by path — consistent with the sensitive-data rule. Pairing UX (surface it in the extension options) is TASK-1333.
- Network **response bodies** are out of v1 scope: MV3 `chrome.webRequest` can't read them without `chrome.debugger` (a visible warning banner). Headers/cookies/metadata only — see TASK-1333 requirement-analysis.
- Diverges from ADR-007 by dropping the renderer-forward. If a future companion ever needs to answer with model output (not just persist), that path would have to be re-introduced; today capture is fire-and-persist, so a direct in-process call is strictly simpler.

## Related

- ADR-007 (english-companion loopback bridge — pattern reused) · TASK-1158 (companion adapter this extends) · ADR-026 (remote allowlist — the HTTP/MCP surface, orthogonal to this loopback adapter) · ADR-030 / TASK-1067 (sync scope: inbox+task sync, conversation gated) · TASK-1329 (parent) · TASK-1331 (dispatcher) · TASK-1332 (image/network kinds) · TASK-1333 (extension).
