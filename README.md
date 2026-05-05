# choda-deck

MCP server providing SQLite-backed task / session / conversation / inbox orchestration for [Claude Code](https://docs.claude.com/claude-code).

Pure Node, Windows-first, MIT.

## Install

```bash
npm install -g choda-deck
# or run on demand
npx choda-deck
```

Requires Node.js >= 20.

## Use with Claude Code

Add to your Claude Code MCP config (`.claude.json` or project-scoped `.mcp.json`):

```json
{
  "mcpServers": {
    "choda-tasks": {
      "command": "npx",
      "args": ["-y", "choda-deck"],
      "env": {
        "CHODA_DATA_DIR": "/absolute/path/to/data",
        "CHODA_CONTENT_ROOT": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

### Environment variables

| Var | Purpose |
|---|---|
| `CHODA_DATA_DIR` | Where the SQLite DB, artifacts, and backups live. Created on first run. |
| `CHODA_CONTENT_ROOT` | Root for knowledge / vault content lookup. Optional. |

### Data layout

```
$CHODA_DATA_DIR/
├── database/choda-deck.db
├── artifacts/<sessionId>/
└── backups/choda-deck-<date>.db
```

Daily backups are taken automatically; restore via the `backup_restore` MCP tool.

## What it gives you

Domain tools across project / workspace / task / phase / inbox / conversation / session / search / roadmap / backup. The full schema is described in `docs/knowledge/` (ADRs) on the [GitHub repo](https://github.com/butterngo/choda-deck).

## Architecture

- SQLite (`better-sqlite3`) — single source of truth
- MCP stdio — AI interaction layer
- Pure Node runtime (no Electron, no PTY)

See [`docs/architecture.md`](https://github.com/butterngo/choda-deck/blob/main/docs/architecture.md) and ADRs in [`docs/knowledge/`](https://github.com/butterngo/choda-deck/tree/main/docs/knowledge) for design details.

## License

MIT — see [LICENSE](./LICENSE).
