---
type: decision
title: "ADR-026: Dual-transport MCP server (stdio + Streamable HTTP) with bearer auth for k8s"
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/mcp/server-bootstrap.ts
    commitSha: b13ef03be1cde91eef90ea4015eb2df98aa50871
  - path: src/adapters/mcp/http-transport.ts
    commitSha: b13ef03be1cde91eef90ea4015eb2df98aa50871
  - path: src/adapters/mcp/instrumented-server.ts
    commitSha: b13ef03be1cde91eef90ea4015eb2df98aa50871
  - path: src/adapters/mcp/__tests__/http-transport.test.ts
    commitSha: b13ef03be1cde91eef90ea4015eb2df98aa50871
  - path: src/adapters/mcp/__tests__/instrumented-server.test.ts
    commitSha: b13ef03be1cde91eef90ea4015eb2df98aa50871
  - path: src/adapters/cli/index.ts
    commitSha: b13ef03be1cde91eef90ea4015eb2df98aa50871
  - path: src/core/paths.ts
    commitSha: b13ef03be1cde91eef90ea4015eb2df98aa50871
createdAt: 2026-05-21
lastVerifiedAt: 2026-05-21
---

> AI-Context: One binary, two transports. `MCP_TRANSPORT=stdio` (default) keeps current Claude Code local UX untouched. `MCP_TRANSPORT=http` runs `StreamableHTTPServerTransport` in stateless mode behind a Node HTTP server, gated by a bearer token (`MCP_HTTP_TOKEN`). For public exposure, the server sits behind a **Cloudflare Tunnel** (no public IP, no inbound port). **Cloudflare Access SSO gate is rejected** — verified incompatible with Claude's MCP client. V1 ships **bearer-only**; OAuth/DCR is a follow-up before exposing to a second user.

## Context

Choda-deck's MCP server today is stdio-only ([[server-bootstrap.ts]] line 62: hardcoded `StdioServerTransport`). That fits the local Claude Code use case but blocks every remote / containerized scenario:

- **k8s pods can't do stdio** — there's no parent process to pipe to. Pods need an HTTP listener that probes can hit and that ingress can route to.
- **Remote Claude Code** (web, mobile, multi-machine) needs a network endpoint, not a child process.
- **Multi-client** (Butter's laptop + phone + a future Copilot agent all talking to the same DB) needs a shared remote server, not N local SQLite copies that drift.

The MCP spec already defines a second transport — **Streamable HTTP** (replaces the older HTTP+SSE transport, single endpoint, supports both streaming and direct JSON responses). The TS SDK ships `StreamableHTTPServerTransport` ([[node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts]]) with stateful + stateless modes.

We want a **single binary** that supports both transports, picked at startup by env var. Forking into `choda-deck-mcp-stdio` and `choda-deck-mcp-http` would duplicate the tool-registration scaffolding ([[server-bootstrap.ts]] lines 39-56), drift over time, and double the test burden.

**Auth scope.** Stdio assumes local trust (a child process is already inside the user's session). HTTP is network-exposed, so we need at minimum a shared secret. Butter's deploy is solo-user / personal k8s — no multi-tenant identity story needed. OAuth 2.1 (the MCP spec's preferred flow) is overkill for v1: it requires a discovery endpoint, redirect handling, and a token issuer — none of which exist in choda-deck's world today.

**Public exposure shape.** Real goal is "publish to internet so Claude mobile can connect", not "private k8s behind VPN". That shifts the threat model — see Edge deployment shape below for the chosen layering ([[CONV-1779334105733-1]]).

**Replica scope.** SQLite (better-sqlite3) is single-writer + file-backed. Multi-replica means Postgres ([[INBOX-366]]) — out of scope here. This ADR ships single-replica k8s; horizontal scale is a separate ADR triggered by INBOX-366.

## Options considered

| Option | Pro | Con |
|---|---|---|
| A. Status quo (stdio only) | Zero change, local-trust simplicity | Blocks k8s entirely, no remote/multi-client path |
| B. Fork into two binaries (`mcp-stdio`, `mcp-http`) | Each binary is single-purpose | Tool registration duplicated → drift; 2× CI matrix; bundling story doubles |
| C. **Single binary, env-switched transport, bearer auth** | One bundle, one tool registry; transport is the only branching point; bearer ≈ 5 lines of middleware | Bearer is coarser than OAuth (no per-tool scopes); leaked token = full DB until rotated |
| D. Single binary + OAuth 2.1 | Spec-aligned, rotation/scope built-in | Needs a token issuer (we don't have one); discovery endpoint; weeks of work for solo-user use case |
| E. Single binary + mTLS only | k8s-native, no app-level secrets | Cert rotation pain on client side (Claude Code, curl, future Copilot); harder to debug |
| F. Single binary + no app auth, ingress-only | Cheapest | Anyone with ingress access gets full DB write; layered defense costs nothing extra |

## Decision

**Chosen: Option C — single binary, `MCP_TRANSPORT` env switch, bearer token auth on HTTP path.** Public exposure is layered via **Cloudflare Tunnel** (no public IP) — auth handled *inside* the MCP server, not at the edge.

### Transport switch

In [[server-bootstrap.ts]] `startMcpServer()`, after building deps, branch on `process.env.MCP_TRANSPORT`:

```ts
const mode = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase()
if (mode === 'http') {
  const token = process.env.MCP_HTTP_TOKEN ?? ''
  if (token.length === 0) {
    process.stderr.write('[choda-deck] MCP_TRANSPORT=http requires MCP_HTTP_TOKEN ...\n')
    process.exit(2)
  }
  await startHttpTransport(() => buildMcpServer(deps).server, { port, bind, token })
  return
}
// ... stdio path
```

Default = `stdio` → existing `.claude.json` configs work unchanged.

### HTTP transport ([[http-transport.ts]])

- **Stateless mode** (`sessionIdGenerator: undefined`) — no in-memory session state, each request stands alone. Forward-compatible with multi-replica Postgres without rework.
- **Fresh `McpServer` + transport per request** — the SDK transport carries `_initialized` state across calls, so reusing a single instance across requests breaks after `initialize`. The bootstrap passes a **factory** (`() => McpServer`); the HTTP handler calls it per request, runs `server.connect(transport).handleRequest(...)`, then closes both. Pattern matches the SDK's `simpleStatelessStreamableHttp.js` example. SQLite service is shared (constructed once, passed into each `buildMcpServer` call) so SQLite-layer cost is amortized; only the `McpServer` wrapper + tool registration is per-request work.
- **Node `http.createServer`** — no Express dependency. The SDK transport speaks `IncomingMessage`/`ServerResponse` directly.
- **Single route** `POST /mcp` → bearer check + content-type check + 4 MB body cap → `transport.handleRequest(req, res, parsedBody)`
- **Health route** `GET /healthz` → 200 OK with `{"ok":true}`, **unauthenticated** (k8s probes shouldn't carry secrets)
- **Port** from `MCP_HTTP_PORT` (default 7337 — arbitrary, documented)
- **Bind** to `0.0.0.0` in container (k8s networking), `127.0.0.1` for local dev (env override `MCP_HTTP_BIND`)
- **JSON response mode** (`enableJsonResponse: true`) — plain JSON replies, no SSE framing needed for simple req/res. Simpler client + simpler tests.

### Auth (HTTP only)

- Required env: `MCP_HTTP_TOKEN` (non-empty). If unset when `MCP_TRANSPORT=http`, server **fails to start with exit code 2** and a clear error — refuse to expose the DB unauthenticated.
- Middleware: check `Authorization: Bearer <token>` on `POST /mcp`. Constant-time compare (`crypto.timingSafeEqual`). Mismatch → 401, empty body.
- `/healthz` exempt.
- Token rotation = `kubectl` secret update + pod restart. No in-app rotation API (Postgres-era concern).
- **Implementation rule: NEVER log the `Authorization` header.** The handler only logs error objects and the listen address — request headers are never serialized to stderr/stdout. Audit on every code change to this file.

Stdio path **never** touches auth — local trust is the contract.

### Edge deployment shape (public exposure)

Decided in [[CONV-1779334105733-1]]. Goal: reachable from Claude mobile over public internet. Selected layering:

1. **Cloudflare Tunnel** (`cloudflared` Deployment in k8s) — dials *outbound* to Cloudflare edge. **No public IP, no inbound port** on the cluster. TLS terminated by Cloudflare with a managed cert.
2. **Bearer token inside the MCP server** — the only auth layer in v1.
3. **No Cloudflare Access SSO gate.** Verified incompatible with Claude's MCP client: the client cannot complete browser-based SSO flows and cannot send the `CF-Access-Client-Id` service-token header. Putting Access in front of `/mcp` would block Claude entirely.

What this means operationally:
- TLS is mandatory but handled by Cloudflare — the choda-deck process binds plain HTTP and is fine; never expose `/mcp` outside the tunnel.
- DDoS / scanning protection comes from "no public IP to scan" — defense by obscurity at the network layer, defense by token at the app layer.
- Token leak = full DB write until rotation. Acceptable for solo deploy with a short rotation cycle.

### V1 sequencing (vs full OAuth)

Per [[CONV-1779334105733-1]] decision: **ship bearer-only as v1**, OAuth/DCR is a follow-up before any second human user joins. Rationale: tunnel already removes the public attack surface, and Claude's MCP client supports both bearer-style auth and OAuth (Dynamic Client Registration). Bearer is the smallest viable step; OAuth migration unblocks multi-user with per-user scoped tokens, which we don't need yet.

### Mobile client UX

- Claude mobile (iOS/Android) **can use** remote MCP servers but **cannot add new ones** — the connector must be added once on `claude.ai` (web/desktop). After that, the connector is visible + usable on mobile signed-in to the same account.
- Implication: token rotation = update connector on claude.ai once; mobile picks up the change on next sync.

### File layout

```
src/adapters/mcp/
├── server-bootstrap.ts       ← branches on MCP_TRANSPORT, owns shared setup + buildMcpServer() helper
├── http-transport.ts         ← NEW: http.Server + bearer middleware + StreamableHTTPServerTransport wiring + /healthz
├── __tests__/http-transport.test.ts  ← NEW: AC bullets covered (healthz, 401/415/413, tools/list parity)
└── (existing files unchanged)
```

`http-transport.ts` exports `startHttpTransport(factory: () => McpServer, opts): Promise<HttpTransportHandle>` returning `{ address, close }` for graceful shutdown.

### Per-tool scoping (TASK-903 amendment, 2026-05-21)

V1 bearer / OAuth gives a hold-token-or-nothing model: any holder can call any registered tool. That's fine for stdio (local trust), but HTTP exposes the same surface to claude.ai connectors, mobile, and any future remote client. Most tools have no business being remote-callable: lifecycle writes (`task_create|update|approve|reject`, `session_*`), maintenance (`backup_*`, `cleanup_*`, `workspace_*`), conversation orchestration, memory promotion, knowledge browsing, and inbox triage transitions.

**Decision**: gate tool registration with an allowlist when `MCP_TRANSPORT=http`. The HTTP surface is **read + capture only** — 6 tools (`REMOTE_TOOL_ALLOWLIST` in [[server-bootstrap.ts]]):

- `project_list`
- `task_list`
- `task_context`
- `inbox_list`
- `inbox_get`
- `inbox_add`

**Mechanism**: optional `toolAllowlist?: ReadonlySet<string>` on [[instrumented-server.ts]] `createInstrumentedServer(...)`. When set, `registerTool(name, ...)` skips both the underlying `server.registerTool` call and the `registeredToolNames` push for non-allowlisted names. The blocked names never appear in `tools/list`, and `tools/call` against them returns the SDK's standard `MCP error -32602: Tool <name> not found` — no info leak. Stdio passes `undefined`, behavior is byte-identical to pre-amendment.

**Rejected: filter at call time** (allow registration, reject at dispatch with `-32601 Method not found`). Cleaner to make blocked tools invisible than to advertise + reject — smaller discovery surface, no inventory leak from `tools/list`.

**Excluded tools + rationale**:
- `inbox_update` — edits to existing rows belong in the local triage flow; remote stale-overwrite risk
- `inbox_convert|archive|ready` — triage decisions need task/conversation context, which lives locally
- `inbox_research` — web fetch + writeback; needs rate-limiting + audit before remote exposure
- `memory_recall|promote_to_knowledge` — memory layer is local-only; remote promotion could pollute knowledge from untrusted sessions
- `knowledge_list|search|get` — ADRs are local-only; remote clients should not browse architecture decisions
- Everything else (`task_create|update|approve|reject`, `session_*`, `backup_*`, `cleanup_*`, `workspace_*`, `conversation_*`, `stats_report`) — write / lifecycle / maintenance; stays inside the local trust boundary

**Startup log** (HTTP mode): `[choda-deck] registered <N> MCP tools (remote allowlist: 6 of <total>)`. Total is computed from a separate unfiltered build so a misconfigured allowlist is obvious in boot output.

**Revisit when**:
- A remote client needs a write tool not on the list → add it explicitly + smoke + update this ADR; don't expand by default
- OAuth token scopes go live (follow-up to ADR-027) → migrate from a single allowlist to per-scope subsets
- An audit/rate-limit story lands for `inbox_research` → consider promoting it onto the remote allowlist

### Standing rule (2026-05-28) — PG surface = allowlist call graph

The Postgres adapter implements only `RemoteOperations` (strict subset of `BackendTaskService` — methods reachable from the call graph of every tool in `REMOTE_TOOL_ALLOWLIST`, plus OAuth validation). The full 16-repository PG adapter shipped in TASK-934 was over-built — the HTTP-only surface never reaches sessions, conversation writes, knowledge, memory, embeddings, session events, agent memories, tool invocations, or documents, so those repos + their migrations were deleted on 2026-05-28. PG can no longer back stdio; `requireBackendForTransport` rejects that combination at boot.

When the allowlist grows, three edits must land in the same PR:
1. Add the tool name to `REMOTE_TOOL_ALLOWLIST` in [[server-bootstrap.ts]].
2. Add the service methods it calls to `RemoteOperations` in [[remote-operations.interface.ts]].
3. Implement those methods on `PostgresTaskService` — restore the corresponding `.pg.ts` repo from git history if needed, add its `migrations.ts` entry, write a smoke test.

Missing step 2/3 → the tool registers fine over HTTP but throws on first invocation (no method on the PG facade). The discipline keeps PG from carrying dead code that nobody can reach but everyone has to maintain.

Restoration cost is real but bounded: each deleted repo is `git show <pre-cleanup-sha>:src/core/domain/repositories/postgres/<name>.pg.ts` away, and the matching migration block can be lifted from the same commit. Treat the deletions as "rolled back to a smaller working set", not "lost forever".

### k8s shape (out of scope for this ADR, captured for context)

- Single replica, RWO PVC for `CHODA_DATA_DIR`
- `Secret` mounted as `MCP_HTTP_TOKEN`
- Service exposed via cloudflared sidecar/Deployment (no public Service / Ingress required)
- Liveness/readiness probe → `GET /healthz`
- Resource limits sized in deploy task, not here

## Why not others

| Option | Rejected because |
|---|---|
| A. Status quo | The whole point of this ADR is to unblock k8s + remote |
| B. Two binaries | Tool registration drift is the same risk we already fight with the `dist/mcp-server.cjs` deprecation alias — doubling it is the wrong direction |
| D. OAuth 2.1 | Solo-user v1 doesn't justify a token issuer; we'd be building scaffolding for a multi-tenant story we don't have. Revisit when a second human user joins |
| E. mTLS only | Client-side cert distribution + rotation is painful for ad-hoc tools (curl during debugging, a phone-side client later). Bearer fits the shape of the actual usage |
| F. Ingress-only auth | "Defense in depth" is cheap here; bearer middleware is ~15 lines. A misconfigured ingress is one `kubectl apply` away from exposing the DB |
| Cloudflare Access SSO gate (variant of C) | **Verified incompatible with Claude's MCP client.** Browser SSO redirect can't complete from the connector context; service-token headers can't be set. Putting Access in front of `/mcp` blocks Claude entirely. CF Tunnel kept; Access removed |

## Consequences

- **Good:**
  - One binary, one tool registry, one test target — no fork.
  - Stdio default = zero migration for existing `.claude.json` configs.
  - Public exposure works via Cloudflare Tunnel — no public IP to scan, free managed TLS, free DDoS layer.
  - Stateless HTTP mode is forward-compatible with multi-replica Postgres (no session state to migrate).
  - Health endpoint unauthenticated → standard k8s probe pattern works out of the box.
  - Bearer is debuggable with curl, which matters during the first deploy.
  - Factory pattern keeps SQLite service hot across requests — per-request cost is only McpServer + tool registration, not DB connect.
- **Bad:**
  - Bearer token = single secret with full DB access. No per-tool scoping. Leak = rotate + restart.
  - `MCP_HTTP_TOKEN` becomes a new required env var for HTTP mode — onboarding step for any future deployer.
  - Stateless mode (fresh server per request) means a few ms of overhead per call for tool re-registration. Negligible for solo use; revisit if request rate climbs.
  - Cloudflare in the trust chain. If they have an outage or revoke the tunnel, MCP is unreachable. Acceptable for personal productivity, not for payment-system criticality.
- **Risks:**
  - **Token in process env** is visible to anyone with pod exec. Mitigate: k8s `Secret` mounted as env, RBAC restricts who can exec. Standard k8s ops.
  - **Unauthenticated `/healthz`** could be probed to confirm the server is running. Acceptable — it leaks "server up", not data. Don't add tool listing or version detail to `/healthz`.
  - **Future feature wanting session affinity** — switch to stateful mode + sticky sessions or DB-backed session store. Not a today problem.
  - **Body parsing** — 4 MB cap via `Content-Length` fast-path; oversized bodies get 413 before reaching the SDK. Chunked-encoded uploads bypass the fast-path but Cloudflare + Node's own limits cap them upstream.
  - **Bearer leak via logs** — mitigated by code rule (never log `Authorization`); needs CI/grep guard if/when log volume grows.

## Impact

- **Files/modules changed:**
  - `src/adapters/mcp/server-bootstrap.ts` — extract `buildMcpServer(deps)` helper; branch on `MCP_TRANSPORT`; delegate to `startHttpTransport` factory when `http`
  - `src/adapters/mcp/http-transport.ts` — NEW: `startHttpTransport()` (http.Server + bearer middleware + StreamableHTTPServerTransport wiring + /healthz, fresh server per request)
  - `src/adapters/mcp/__tests__/http-transport.test.ts` — NEW: 12 tests covering AC bullets
  - `src/adapters/cli/index.ts` — banner mentions `MCP_TRANSPORT`, `MCP_HTTP_PORT`, `MCP_HTTP_TOKEN`, `MCP_HTTP_BIND`
  - `CLAUDE.md` — env var table + token-generation snippet + transport-mode docs
- **Dependencies affected:** none added. SDK transitive `@hono/node-server` already pulled.
- **Migration needed:** None. Default transport stays stdio.

## Revisit when

- A second human user / agent needs different scopes → graduate to OAuth 2.1 / DCR. Today: one Butter, one k8s.
- [[INBOX-366]] Postgres migration ships → re-evaluate stateful HTTP mode (DB-backed sessions) for richer multi-client UX.
- Per-request server-build overhead becomes measurable in production traces → cache built McpServer + use stateful mode with session IDs.
- Token leaks via logs ever observed → add a CI grep guard against `req.headers.authorization` or `Bearer ` in source.
- A second deployment (staging vs prod, or shared org instance) emerges → consider mTLS or OAuth, not because bearer broke but because operational surface grew.
- `/healthz` ever becomes a side-channel (e.g. leaks tool list or task counts) → audit + lock down.
- Cloudflare introduces an MCP-compatible Access flow (current Access SSO breaks Claude clients) → re-add Access for an extra identity layer.

## Related

- Decided in: [[CONV-1779334105733-1]] — public exposure model (Tunnel + server-side bearer; CF Access SSO gate rejected; V1 = bearer-only)
- Builds on: [[ADR-001-architecture-overview]] — pure Node MCP server identity preserved (no Electron, no PTY)
- Builds on: [[ADR-018-knowledge-layer]] — knowledge layer surfaces are accessed through the same tool handlers regardless of transport
- Triggers: [[INBOX-366]] — Postgres migration is gated by "we actually want >1 replica"; this ADR ships single-replica + sets the stage
- Defers to future ADR: k8s manifest shape (Deployment + PVC + Service + cloudflared) — deploy task references this ADR but the YAML lives in a separate runbook
- Complements: existing `dist/mcp-server.cjs` deprecation path ([[server.ts]] line 17) — both transports go through `startMcpServer()`, so the deprecation timeline is unaffected
