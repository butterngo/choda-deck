---
type: feature
title: Dual-transport MCP server (stdio + HTTP)
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/mcp/server-bootstrap.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/adapters/mcp/instrumented-server.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/adapters/mcp/http-transport.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
realizesTasks: ["TASK-624","TASK-898","TASK-899","TASK-900","TASK-903"]
inWorkspaces: ["main"]
effortBand: L
status: in-progress
---

One TypeScript binary serves two transports: stdio for local Claude Code (full tool surface) and stateless HTTP for remote/k8s (a narrowed 6-tool read+capture allowlist). Tool registration is a thin, instrumented facade over repository operations. ADR-026 owns the rationale; the per-transport allowlist is enforced at registration time.

`REMOTE_TOOL_ALLOWLIST` lives in `server-bootstrap.ts`. Conceptually INTEGRATES_WITH [[feature-postgres-remote-backend]] and [[feature-oauth-dcr]] (edge type not writable via current API).
