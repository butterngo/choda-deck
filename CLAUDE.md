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
- Architecture decisions: `docs/knowledge/` (code-coupled, frontmatter + staleness tracking — see ADR-018). Discover via MCP `knowledge_list` / `knowledge_get`.
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

## Output style

Layers on top of harness tone defaults. Targets Butter-specific patterns.

### Forbidden
- Vietnamese preamble: "Để tôi...", "Trước tiên...", "Mình sẽ..."
- Postamble that recaps the diff ("Done — I edited X then Y") — the diff already shows it
- Sign-offs: "Hope this helps", "Let me know if you need anything"
- Step narration between tool calls
- Hedging when the answer is known — state it, don't hedge

### Soft preferences
- Reply under ~8 lines? Use prose, not bullets+bold headers
- Bullets only for ≥3 parallel items, or when each line would start with the same prefix
- One question per end-of-turn; don't stack options unless explicitly comparing

### Plan mode exception
Plan mode is allowed to be verbose — alignment > brevity there.

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

## MCP Transport Modes (ADR-026)

The server supports two transports from a single binary, selected at startup via `MCP_TRANSPORT`.

| Env var | Default | Required when | Purpose |
|---|---|---|---|
| `MCP_TRANSPORT` | `stdio` | — | `stdio` (local Claude Code) or `http` (remote / k8s) |
| `MCP_HTTP_PORT` | `7337` | `MCP_TRANSPORT=http` | Listen port |
| `MCP_HTTP_BIND` | `0.0.0.0` | `MCP_TRANSPORT=http` | Bind address (`127.0.0.1` for local dev) |
| `MCP_HTTP_TOKEN` | — | `MCP_TRANSPORT=http` without OAuth | Bearer token — full DB access on match. Ignored when `MCP_OAUTH_MODE=1` |
| `MCP_OAUTH_MODE` | unset | — | Set to `1` to switch `/mcp` from bearer to OAuth (ADR-027) |
| `MCP_OAUTH_ISSUER` | — | `MCP_OAUTH_MODE=1` | Public origin (e.g. `https://mcp.choda.dev`, no trailing slash) — used in `/.well-known/*` metadata + `WWW-Authenticate` |
| `MCP_OAUTH_CONSENT_PASSWORD_FILE` | `sensitive_information/oauth-consent-password.txt` | `MCP_OAUTH_MODE=1` | Path to file containing the 64-char hex SHA-256 hash of the consent password |

**Stdio (default)** — unchanged behavior, what `.claude.json` registrations use today.

**HTTP** — Streamable HTTP transport in **stateless** mode. Endpoints:
- `POST /mcp` — bearer-gated (`Authorization: Bearer <token>`), JSON only, 4 MB body cap
- `GET /healthz` — unauthenticated, returns `{"ok":true}` (k8s liveness/readiness probe)

Token generation:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Store the token at `sensitive_information/mcp-http-token.txt` (gitignored) locally, or as a k8s `Secret` in cluster. Do not commit. Rotation = regenerate + restart pod + update client config.

## MCP OAuth Mode (ADR-027)

When `claude.ai`'s connector UI is the target client, static bearer is unsupported — flip on OAuth instead. Adds five endpoints (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `POST /register`, `GET|POST /authorize`, `POST /token`) and makes `/mcp` validate against the `oauth_tokens` SQLite table instead of `MCP_HTTP_TOKEN`. 401 responses include `WWW-Authenticate: Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource"`.

Consent password generation:
```bash
read -rs PASS && printf '%s' "$PASS" | node -e "process.stdin.on('data',d=>process.stdout.write(require('crypto').createHash('sha256').update(d.toString().trim()).digest('hex')))" > sensitive_information/oauth-consent-password.txt
```

Operational notes:
- **CF WAF allowlist `160.79.104.0/21` applies to `/mcp` path ONLY.** `/authorize`, `/token`, `/register`, `/.well-known/*` must stay globally reachable — they're hit by the user's browser, not the broker.
- **Password rotation:** rewrite the file + restart the pod. Rotating revokes nothing; old `oauth_tokens` rows stay valid until their `access_expires_at` (1h) / `refresh_expires_at` (30d).
- **Replayed refresh token → entire chain revoked** for that `client_id` (OAuth 2.1 §4.13.2).
