---
type: feature
title: Choda gateway (OpenAPI ingestion + credential profiles)
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
anchorTaskId: TASK-970
realizesTasks: ["TASK-970","TASK-688","TASK-690","TASK-693","TASK-695","TASK-696","TASK-724","TASK-725","TASK-1004"]
inWorkspaces: ["choda-gateway"]
effortBand: L
status: in-progress
---

A gateway that ingests OpenAPI specs (3.0.x/3.1.x) and exposes them as MCP tools with per-call credential resolution. Substantially implements ADR-006: OpenAPI parser + spec→manifest transform, a `CredentialProvider` interface with all four providers (oauth2-cc, api-key, cookie-jar, exec-script), a central router with secret resolution + audit + retry, and REST/MCP/CLI upstream adapters. Runs as an MCP server and a CLI.

The original ADR-006 sub-task breakdown (TASK-959→969) and the PIM product tools (TASK-721/722) were CANCELLED, but the capability was delivered under the epic + build tasks instead — so this is a working gateway, not a skeleton. Open work: Phase-2 (TASK-724/725) and cookie-forwarding to PIM (TASK-1004, blocked-by TASK-723). TASK-1000 tracks documenting why the sub-tasks were cancelled.

Anchor epic TASK-970. INTEGRATES_WITH [[feature-dual-transport-mcp-server]] (edge not writable via current API).

**Workspace `choda-gateway`.** 12 code anchors: CLI entry `main` + MCP server `buildMcpServer` + `createRouter`; OpenAPI `parseSpec` + `transformSpec`; auth `CredentialProvider` + `createProviderRegistry` + the 4 providers (`createOAuth2CcProvider`, `createApiKeyProvider`, `createCookieJarProvider`, `createExecScriptProvider`); `createRestAdapter`. Query via `code_ref_prefix` filtered to this workspace.
