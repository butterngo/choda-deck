@CLAUDE.local.md

# Choda Deck — MCP Memory + Orchestration Layer for Claude Code

## Identity

Pure Node MCP server — SQLite-backed task / session / conversation / inbox orchestration exposed via stdio to Claude Code. No UI, no Electron. Windows-first, TypeScript, MIT OSS.

## Architecture

- SQLite (better-sqlite3) = single source of truth
- MCP stdio = AI interaction layer
- Pure Node runtime (no Electron, no PTY, no renderer)

## Current Focus

Use `choda-tasks` MCP `project_context` / `roadmap` / `task_list` for live state — don't hardcode current task here.

## Context Sources

- Vault context: read `vault/10-Projects/choda-deck/context.md`
- Architecture decisions: `vault/10-Projects/choda-deck/docs/decisions/` and `docs/decisions/`
- In-repo architecture: `docs/architecture.md`
- **Code graph: `graphify-out/GRAPH_REPORT.md`** — navigable map of nodes, communities, god-nodes, surprising connections. May drift from `main` — regenerate with `/graphify update ./src` when stale.

Use `choda-tasks` MCP tools (`task_context`, `task_list`) for task details.

## Key Files

- `src/adapters/mcp/server.ts` — MCP server entry point
- `src/adapters/mcp/mcp-tools/` — individual MCP tool handlers
- `src/core/domain/sqlite-task-service.ts` — SQLite schema + CRUD facade
- `src/core/domain/task-types.ts` — type definitions
- `src/core/domain/lifecycle/` — transactional lifecycle services (ADR-015)
- `src/core/paths.ts` — `resolveDataPaths()` — single source for DB/artifacts/backups paths
- `src/core/backup-service.ts` — daily backup + restore (ADR-012)

## Conventions

- KISS — no unnecessary abstractions
- Test with vitest
- File naming: kebab-case
- TS style: single quotes, no semi, 100 cols, explicit return types on public functions (`.claude/rules/typescript.md`)
- Always run `pnpm run lint` before suggesting done
- No auto-commits — commits only on explicit request

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

## MCP Tools Available

`choda-tasks` server exposes domain tools across: project, workspace, task, phase, inbox, conversation, session, search, roadmap, backup. Source of truth = `src/adapters/mcp/server.ts` + `src/adapters/mcp/mcp-tools/`. After source changes: `pnpm run build:mcp` + `/mcp reconnect`.

Register in `.claude.json` (production — uses bundled `dist/mcp-server.cjs`):

```json
{
  "mcpServers": {
    "choda-tasks": {
      "command": "node",
      "args": ["C:\\dev\\choda-deck\\dist\\mcp-server.cjs"],
      "cwd": "C:\\dev\\choda-deck",
      "env": {
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
