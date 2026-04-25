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
- **Visual/UX spec: `DESIGN.md`** (root) — dark-only editor-native theme, colors, typography, component styling, layout rules. Canonical for any renderer work.
- **Code graph: `graphify-out/GRAPH_REPORT.md`** — navigable map of nodes, communities, god-nodes, surprising connections. Useful for onboarding / exploring a region of the codebase. May drift from `main` — regenerate with `/graphify update ./src` when stale.

Use `choda-tasks` MCP tools (`task_context`, `task_list`) for task details.

## Key Files

- `src/core/domain/sqlite-task-service.ts` — SQLite schema + CRUD
- `src/adapters/mcp/server.ts` — MCP server entry point
- `src/adapters/mcp/mcp-tools/` — individual MCP tool handlers
- `src/core/domain/task-types.ts` — type definitions
- `src/core/paths.ts` — `resolveDataPaths()` — single source for DB/artifacts/backups paths
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
- **UI/renderer work follows `DESIGN.md`** — dark-only `#1e1e1e`, `.deck-*` class prefix, plain CSS under `src/renderer/src/assets/deck.css` (no Tailwind / CSS-in-JS / component libs), status colors shared across tasks/sessions/conversations, no gradients, no hover-translate, modal-only shadows

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

`choda-tasks` server exposes domain tools across: project, workspace, task, phase, inbox, conversation, session, search, roadmap. Source of truth = `src/adapters/mcp/server.ts` + `src/adapters/mcp/mcp-tools/`. After source changes: `pnpm run build:mcp` + `/mcp reconnect`.

Register in `.claude.json` (production — uses bundled `dist/mcp-server.cjs`):

```json
{
  "mcpServers": {
    "choda-tasks": {
      "command": "C:\\dev\\choda-deck\\node_modules\\electron\\dist\\electron.exe",
      "args": [
        "C:\\dev\\choda-deck\\dist\\mcp-server.cjs"
      ],
      "cwd": "C:\\dev\\choda-deck",
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "CHODA_DATA_DIR": "C:\\dev\\choda-deck\\data",
        "CHODA_CONTENT_ROOT": "C:\\Users\\hngo1_mantu\\vault"
      }
    }
  }
}
```

**Data layout** (`CHODA_DATA_DIR/`):
```
data/
├── database/choda-deck.db
├── artifacts/<sessionId>/
└── backups/choda-deck-<date>.db
```

Legacy `CHODA_DB_PATH` still accepted as override (logs a warning). Migration: `node scripts/migrate-data-layout.mjs`.
