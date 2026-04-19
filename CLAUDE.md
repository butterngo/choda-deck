@CLAUDE.local.md

# Choda Deck — AI Development Workflow Engine

## Identity

Electron desktop app (React 19 + xterm.js + better-sqlite3). Windows-first, TypeScript, MIT OSS.

## Architecture

- SQLite (better-sqlite3) = source of truth for structure
- .md files = content store
- MCP stdio = AI interaction layer

## Current Focus

M1 (Core Primitives) shipped. Use `choda-tasks` MCP `project_context` / `roadmap` / `task_list` for live state — don't hardcode current task here.

## Context Sources

- Vault context: read `vault/10-Projects/choda-deck/context.md`
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
- Always run `pnpm run lint` before suggesting done
- No auto-commits — commits only on explicit request
- No dev server claims without proof — exercise UI in actual Electron window

## Git Worktree Workflow

Per-project pattern — worktrees live in `C:\dev\choda-deck.worktrees\` (sibling to the repo, not inside it — no `.gitignore` needed).

```
C:\dev\
├── choda-deck\              ← main checkout
└── choda-deck.worktrees\
    ├── hotfix\
    ├── feature-x\
    └── ...
```

Commands (run from `C:\dev\choda-deck\`):

```bash
git worktree add ../choda-deck.worktrees/hotfix main       # create
git worktree list                                          # inspect
git worktree remove ../choda-deck.worktrees/hotfix         # cleanup
```

Use worktrees for parallel branches (hotfix + feature at once) instead of stash/switch churn.

## MCP Tools Available

`choda-tasks` server exposes domain tools across: project, workspace, task, phase, inbox, conversation, session, search, roadmap. Source of truth = `src/tasks/mcp-task-server.ts` + `src/tasks/mcp-tools/`. After source changes: `pnpm run build:mcp` + `/mcp reconnect`.

Register in `.claude.json` (production — uses bundled `dist/mcp-server.cjs`):

```json
{
  "mcpServers": {
    "choda-tasks": {
      "command": "node",
      "args": ["dist/mcp-server.cjs"],
      "cwd": "C:\\dev\\choda-deck",
      "env": {
        "CHODA_DB_PATH": "./choda-deck.db",
        "CHODA_CONTENT_ROOT": "C:\\Users\\hngo1_mantu\\vault"
      }
    }
  }
}
```
