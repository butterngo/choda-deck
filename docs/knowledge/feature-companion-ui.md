---
type: feature
title: Companion UI (web + mobile)
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
anchorTaskId: TASK-807
realizesTasks: ["TASK-807","TASK-830","TASK-855","TASK-856"]
inWorkspaces: ["choda-deck-companion"]
effortBand: XL
status: in-progress
---

A read-mostly companion surface — a React web SPA and an Expo/React-Native mobile app over a shared package — that views Tasks, Queue, Conversations and Inbox via the HTTP transport with live SSE updates. The web (TASK-807) and mobile (TASK-830) React migrations shipped; a large design-system v2 modernization (TASK-855/856 + the 800-series) is the open backlog.

Depends on [[feature-dual-transport-mcp-server]]. Anchor epic TASK-807.

**Workspace `choda-deck-companion`** (pnpm monorepo: `packages/shared`, `packages/web`, `packages/server`, root `mobile/`). Code anchors (9): shared barrel + `createApiClient` + shared types + `applySseEvent` reducer; web `App` + `router` + `useLiveQueue`; server Hono entry; mobile `app/_layout.tsx`. Query them via `code_ref_prefix({projectId, ...})` filtered to this workspace.
