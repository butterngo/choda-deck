---
type: feature
title: Self-hosted OAuth 2.0 DCR for the claude.ai connector
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/mcp/oauth/discovery.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/adapters/mcp/oauth/token.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
realizesTasks: ["TASK-901","TASK-980","TASK-1039"]
inWorkspaces: ["main"]
effortBand: M
status: in-progress
---

Self-hosted OAuth 2.0 Dynamic Client Registration so the claude.ai remote connector can register and authenticate against the HTTP transport. Discovery, register, authorize, token, PKCE and a consent template, backed by `oauth_*` tables. ADR-027.

Currently being reworked (TASK-1039 / ADR-034) to move from self-issued tokens to a Keycloak-backed on-origin proxy, superseding ADR-027. Status moves to shipped once the Keycloak switch lands. Depends on [[feature-dual-transport-mcp-server]].
