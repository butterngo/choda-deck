@CLAUDE.local.md

# Choda Deck

Comprehensive AI workspace (Electron + React + xterm.js + node-pty + sql.js). Multi-project terminal with built-in task management (Kanban, Roadmap, Focus views). Long-term: replaces Obsidian as unified surface for vault + AI collaboration (ADR-007).

## Vault context

Knowledge artifacts live in the vault. Always read them before making non-trivial changes.

- Project context: `vault/10-Projects/choda-deck/context.md`
- Architecture (components, IPC contract, flows): `docs/architecture.md`
- Decisions (in vault): `vault/10-Projects/choda-deck/docs/decisions/`
- Decisions (in repo): `docs/decisions/`
- Roadmap: `vault/10-Projects/choda-deck/roadmap.md`

## Authoritative in-repo specs

- `docs/requirements.md` — MVP scope, Q1/Q2 decisions, big-picture vision.
- `docs/architecture.md` — component overview, IPC contract, data flows.

When docs/vault context disagrees with code: code describes current state, docs describe target state. Do not "fix" code to match doc prose unless the task is explicitly that refactor.

## Conventions

- `.claude/rules/typescript.md` — TS style (single quotes, no semi, 100 cols, explicit return types on public functions)
- `.claude/rules/react.md` — React 19 patterns actually used (function components, useRef for imperative handles, cleanup in useEffect)
- `.claude/rules/electron-ipc.md` — IPC channel naming, invoke vs send, per-session event streams, preload surface rules

## Per-layer context

- `src/main/CLAUDE.md` — Electron main process, PTY lifecycle, session map
- `src/preload/CLAUDE.md` — contextBridge API surface, what can and cannot live here
- `src/renderer/CLAUDE.md` — React renderer, xterm mount, `window.api`-only rule

## Data architecture

- **SQLite (sql.js)** = source of truth for structure (tasks, epics, relationships)
- **.md files** = content store (descriptions, specs, ADRs — git-friendly)
- Task data in `src/tasks/` — SQLite service, vault importer, type definitions

## MCP Task Server

Task management tools available via MCP stdio for Claude Code:

```bash
npm run mcp:tasks   # starts MCP server
```

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

Tools: `task_context`, `task_list`, `task_create`, `task_update`, `phase_list`, `phase_create`, `feature_list`, `feature_create`, `roadmap`, `search`.

## Working style

- **KISS first.** Simplest thing that satisfies the requirement. No premature abstractions.
- **Clarify before implementing** when scope is ambiguous. Ask one focused question, do not guess.
- **No auto-commits.** Commits only on explicit request.
- **No dev server claims without proof.** For UI changes, launch `npm run dev`, exercise the feature in the actual Electron window, then report. Type-check alone is not validation.
- **ViewRouter is live.** `App.tsx` uses `<ViewRouter>` with Terminal, Tasks, Roadmap, Focus tabs. New views plug into ViewRouter.
