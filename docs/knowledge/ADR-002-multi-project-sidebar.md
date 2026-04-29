---
type: decision
title: "ADR-002: Multi-project sidebar with per-project terminal sessions"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-04-12
lastVerifiedAt: 2026-04-29
---

# ADR-002: Multi-project sidebar with per-project terminal sessions

> **Superseded by [ADR-006](ADR-006-project-workspace-hierarchy.md)** — flat project list replaced by Project → Workspace hierarchy. Decisions below about state management, mount-once, and keyboard shortcuts still apply. Config schema and sidebar structure superseded.

## Context

Phase 0 goal: switch giữa multiple project terminals không cần alt-tab. Spike ban đầu chỉ có 1 hardcoded project. Cần mở rộng sang N projects với session persistence.

Key questions:
- State management: Zustand/Redux hay plain useState?
- Terminal lifecycle: dispose on switch hay mount-once hide/show?
- Config: hardcode hay file-based?

## Decision

1. **useState + props** — không dùng state library (R6 chưa close). Simple, đủ cho MVP. ✅ *Still applies*
2. **Mount-once, hide/show via CSS** — mỗi project có 1 Terminal instance, mounted lần đầu, `display: none` khi inactive. ✅ *Still applies*
3. **projects.json** — config file-based. ⚠️ *Schema superseded by ADR-006 (flat → project/workspace hierarchy)*
4. **Single top-level keydown listener** — Ctrl+1..9 jump, Ctrl+Tab cycle. ✅ *Still applies*

## Consequences

- Sidebar component (`Sidebar.tsx`) list projects với shortcut numbers
- TerminalView component (`TerminalView.tsx`) — extracted terminal boot/cleanup logic, receives `visible` prop
- App.tsx là orchestrator — holds `projects[]` + `activeId` state, passes down
- Keyboard shortcuts work immediately — no extra config needed
- Adding projects at runtime works (UI form + IPC to main → save projects.json)
- R6 decision (state library) can upgrade later without architectural change — just lift state into store

## What changed in ADR-006

| ADR-002 (this) | ADR-006 (supersedes) |
|---|---|
| 1 project = 1 terminal = 1 board | 1 project has N workspaces, each workspace has terminal |
| Flat sidebar list | Tree sidebar: project → workspaces |
| `projects.json` = flat array | `projects.json` = project with `workspaces[]` + `taskPath` |
| Board per project = per terminal | Board per project, shared across workspaces |

## Related

- [[ADR-006-project-workspace-hierarchy]]
- [[phase-0-multi-project-terminal]]
- [[TASK-206_graph-cli]]
