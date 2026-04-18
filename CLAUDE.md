@CLAUDE.local.md

# Choda Deck — AI Development Workflow Engine

## Identity

Electron desktop app (React 19 + xterm.js + better-sqlite3). Windows-first, TypeScript, MIT OSS.

## Architecture

- SQLite (better-sqlite3) = source of truth for structure
- .md files = content store
- MCP stdio = AI interaction layer

## Current Focus

ADR-008 accepted. Building Milestone 1: Core Primitives (Conversation + Context + Session).

Next task: TASK-501 — SQLite schema migration (sessions, context_sources, conversations tables)

## Context Sources

- Vault context: read `vault/10-Projects/choda-deck/context.md`
- Handoff: read `vault/10-Projects/choda-deck/handoff.md`
- Roadmap: read `vault/10-Projects/choda-deck/roadmap.md`
- Milestones: `vault/10-Projects/choda-deck/phases/milestone-{1,2,3}-*.md`
- Tasks: `vault/10-Projects/choda-deck/tasks/` (TASK-501..507 = M1)
- Architecture decisions: `vault/10-Projects/choda-deck/docs/decisions/` and `docs/decisions/`
- In-repo architecture: `docs/architecture.md`

Use `choda-tasks` MCP tools (`task_context`, `task_list`) for task details.

## Key Files

- `src/tasks/sqlite-task-service.ts` — SQLite schema + CRUD
- `src/tasks/mcp-task-server.ts` — MCP server (10 tools)
- `src/tasks/task-types.ts` — type definitions
- `src/renderer/src/RoadmapView.tsx` — hierarchy UI

## Per-layer context

- `src/main/CLAUDE.md` — Electron main process, PTY lifecycle, session map
- `src/preload/CLAUDE.md` — contextBridge API surface
- `src/renderer/CLAUDE.md` — React renderer, xterm mount, `window.api`-only rule

## Conventions

- KISS — no unnecessary abstractions
- Test with vitest
- File naming: kebab-case
- TS style: single quotes, no semi, 100 cols, explicit return types on public functions (`.claude/rules/typescript.md`)
- React 19 patterns (`.claude/rules/react.md`)
- IPC channel naming + preload rules (`.claude/rules/electron-ipc.md`)
- Always run `npm run lint` before suggesting done
- No auto-commits — commits only on explicit request
- No dev server claims without proof — exercise UI in actual Electron window

## MCP Tools Available

`choda-tasks` server (10 tools): `task_context`, `task_list`, `task_create`, `task_update`, `phase_list`, `phase_create`, `feature_list`, `feature_create`, `roadmap`, `search`.

M1 will add: `project_context`, `session_start`, `session_end`, conversation protocol tools, skill registry tools.

Register in `.claude.json`:

```json
{
  "mcpServers": {
    "choda-tasks": {
      "command": "npx",
      "args": ["ts-node", "src/tasks/mcp-task-server.ts"],
      "cwd": "C:\\dev\\choda-deck",
      "env": {
        "CHODA_DB_PATH": "./choda-deck.db",
        "CHODA_CONTENT_ROOT": "C:\\Users\\hngo1_mantu\\vault"
      }
    }
  }
}
```

ADR-007 (Obsidian replacement) is **superseded** by ADR-008. Files-related tasks TASK-406..417 are archived.
