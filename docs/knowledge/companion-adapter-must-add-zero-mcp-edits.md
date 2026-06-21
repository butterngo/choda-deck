---
type: gotcha
title: Companion adapter must add ZERO MCP edits
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-20
lastVerifiedAt: 2026-06-20
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** extending the companion server — adding an endpoint, a new read, or wiring it into boot.

**Context:** `src/adapters/companion/` is a sibling adapter to `cli/` and `mcp/`, a thin layer over `src/core` services. It exists precisely so the web UI has a local API without touching the MCP surface.

**Business rule:** the companion adapter must never edit MCP code — not `mcp-tools/`, not `REMOTE_TOOL_ALLOWLIST` / `RemoteOperations` / `PostgresTaskService`, not the `/mcp` transport. Isolation IS the contract: a companion change must never alter the tool list, the OAuth-gated pod surface, or MCP behavior.

**Resolution:** add HTTP routes + core reuse only; prove isolation with `git diff` touching solely `src/adapters/companion/` (+ minimal `core/sync` reuse). If you find yourself editing the allowlist, you're in the wrong adapter. Precedent: `http-transport.ts` already serves non-MCP routes (`/sync/since`, `/sync/apply`) beside `/mcp` — extra HTTP over shared core is the established pattern.
