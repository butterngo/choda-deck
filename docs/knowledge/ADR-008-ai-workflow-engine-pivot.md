---
type: decision
title: "ADR-008: Pivot — Choda Deck as AI Development Workflow Engine"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-04-15
lastVerifiedAt: 2026-04-29
---

# ADR-008: Pivot — Choda Deck as AI Development Workflow Engine

## Context

ADR-007 framed Choda Deck as "comprehensive AI workspace replacing Obsidian" — file browser, markdown viewer, knowledge base, inbox processing. After building Phase 0 (terminal) and Phase A (SQLite + MCP + roadmap), we identified a deeper insight:

**The real value is not replacing Obsidian's features. It's automating the development workflow pattern that makes Claude Code effective.**

Evidence from automation-rule project: a manual system of context files (context.md), session handoffs (handoff.md), conversation tracking (conversation.md), ADRs, skill files, and coding conventions (.claude/rules/) makes Claude Code dramatically more productive. But this system is:

- **Entirely manual** — developer maintains every file by hand
- **Fragile** — Obsidian MCP fails intermittently, wikilinks don't resolve, skills don't auto-invoke
- **Not portable** — pattern knowledge lives in one developer's head, not in a tool

The question is not "how do we replace Obsidian?" but **"how do we make every Claude Code session as effective as automation-rule sessions, automatically?"**

## Decision

**Choda Deck = AI Development Workflow Engine** — a desktop app that orchestrates the full development lifecycle between a human architect and Claude Code.

### Five layers

| Layer | Name | What it does |
|---|---|---|
| L1 | Project Context Engine | Auto-compiles WHO/WHAT/HOW context from SQLite + .md files. One MCP call = full project understanding. |
| L2 | Conversation & Decision Tracking | First-class conversation threads (FE↔BE, design Q&A). Linked to tasks and ADRs. Replaces manual conversation.md. |
| L3 | Session Lifecycle | Auto-handoff at session end, auto-resume at session start. Claude Code never starts cold. |
| L4 | Skill & Convention Registry | Skills indexed in SQLite with trigger patterns. Auto-suggest relevant skills per task/project context. |
| L5 | Cross-project Intelligence | Pattern reuse detection. "You built MCP server in project A — here's how it was done" when working on project B. |

### What changes from ADR-007

| ADR-007 concept | ADR-008 replacement |
|---|---|
| File browser replacing Obsidian | Not a goal — Obsidian can coexist, or not. Irrelevant. |
| Markdown viewer + wikilink resolution | Minimal viewer for .md content display. Not a feature, just a utility. |
| Knowledge base browser | Folded into L5 cross-project intelligence |
| Inbox processing | Folded into L2 conversation tracking |
| Skill catalog UI | Folded into L4 skill registry |
| Phase A → B → C → D linear roadmap | Replaced by Layer-based roadmap with different priorities |

### What stays from ADR-007

- SQLite = source of truth for structure (tasks, relationships, hierarchy)
- .md files = content store (descriptions, specs, ADRs)
- MCP stdio = AI interaction layer
- Phase → Feature → Epic → Task hierarchy
- Terminal layer (Phase 0) unchanged

### Source of truth (unchanged)

| Data | Source | Reason |
|---|---|---|
| Task structure | SQLite | Fast queries, constraints, relationships |
| Content | .md files | Git-friendly, AI read/write |
| Conversations | SQLite | Queryable threads, linked entities |
| Sessions | SQLite | Auto-resume, handoff history |
| Skills | SQLite metadata + .md content | Registry for auto-suggest, content for AI to read |
| Cross-project links | SQLite | Pattern matching, related context |

## Consequences

- Roadmap rewritten around 5 layers instead of Phase A→D
- Existing Phase A work (SQLite schema, MCP server, vault importer, roadmap view) remains — it's foundation for L1
- Phase B tasks (TASK-406 → TASK-417) archived — file browser is no longer a primary goal
- New tasks created for L1, L2, L3 (highest impact layers)
- L4, L5 deferred until L1+L3 prove the pattern
- Success metric shifts from "can I close Obsidian?" to "does Claude Code start every session with full context automatically?"

## Risks

| Risk | Mitigation |
|---|---|
| Over-engineering — 5 layers sounds complex | L1 + L3 are just 4-5 MCP tools + 3 SQLite tables. Start there. |
| Scope creep from automation-rule patterns | Only automate patterns that are proven manual — no speculative features |
| SQLite schema grows unwieldy | Keep tables normalized, add only when needed |
| MCP tool explosion | Cap at ~15 tools total. Each tool does one thing well. |

## Related

- [[ADR-007-choda-deck-replaces-obsidian]] — superseded
- [[ADR-004-sqlite-task-management]] — still valid, foundation for all layers
- [[ADR-005-vault-import-sync]] — still valid for .md content ingestion

## Update — 2026-04-19 (TASK-526)

L3 Session Lifecycle: model simplified — **N parallel active sessions per workspace** allowed (Butter often runs test/code/debug terminals concurrently against the same workspace). Status set collapsed from `active|completed|abandoned` to `active|completed`; `abandonStaleSession` removed. CHECK constraint enforces the 2-status set at the DB level.
