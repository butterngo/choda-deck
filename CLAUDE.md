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
- Code coupling: use the `code_ref` / `TOUCHES` layer via `task_touches` (the graphify code-graph was retired — see ADR-033).

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
| `MCP_OAUTH_MODE` | unset | — | Set to `1` to switch `/mcp` from bearer to Keycloak-backed OAuth (ADR-034) |
| `MCP_OAUTH_ISSUER` | — | `MCP_OAUTH_MODE=1` | Public origin of THIS server (e.g. `https://mcp.choda.dev`, no trailing slash) — used in `/.well-known/*` metadata + `WWW-Authenticate` |
| `MCP_OIDC_ISSUER` | — | `MCP_OAUTH_MODE=1` | Keycloak realm issuer (e.g. `https://id.choda.dev/realms/choda`) — auth/token/JWKS endpoints derived from it |
| `MCP_OIDC_CLIENT_ID` | — | `MCP_OAUTH_MODE=1` | Pinned Keycloak public client id the connector registers as |
| `MCP_OIDC_AUDIENCE` | = `MCP_OIDC_CLIENT_ID` | — | Expected token `aud`/`azp` checked on `/mcp` |
| `MCP_OIDC_CLIENT_SECRET_FILE` | — | only if pinned client is confidential | Path to the Keycloak client secret (gitignored under `sensitive_information/`) |

**Stdio (default)** — unchanged behavior, what `.claude.json` registrations use today.

**HTTP** — Streamable HTTP transport in **stateless** mode. Endpoints:
- `POST /mcp` — bearer-gated (`Authorization: Bearer <token>`), JSON only, 4 MB body cap
- `GET /healthz` — unauthenticated, returns `{"ok":true}` (k8s liveness/readiness probe)

Token generation:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Store the token at `sensitive_information/mcp-http-token.txt` (gitignored) locally, or as a k8s `Secret` in cluster. Do not commit. Rotation = regenerate + restart pod + update client config.

### Remote tool allowlist

HTTP mode exposes a narrowed surface — the **6-tool read + capture allowlist** (`REMOTE_TOOL_ALLOWLIST` in `src/adapters/mcp/server-bootstrap.ts`):

- `project_list`
- `task_list`
- `task_context`
- `inbox_list`
- `inbox_get`
- `inbox_add`

Everything else (`task_create`, `task_update`, `session_*`, `backup_*`, `cleanup_*`, `workspace_*`, `conversation_*`, `memory_*`, `knowledge_*`, `code_ref_*`, `touches_*`, `task_touches`, `graph_edges`, `feature_projection`, `inbox_update|convert|archive|ready|research`, `stats_report`) stays **stdio-only**. Non-allowlisted tools are not registered at all — they never appear in `tools/list` and respond `MCP error -32602: Tool <name> not found` if called by name. Stdio mode keeps every tool (local trust contract, unchanged). See ADR-026 §Per-tool scoping for rationale.

### Backend surface for HTTP mode (2026-05-28 narrowing)

Stdio uses SQLite with the full `BackendTaskService` surface. HTTP uses either SQLite or Postgres, but only via the narrow `RemoteOperations` port (`src/core/domain/remote-operations.interface.ts`) — strict subset of the methods reachable from `REMOTE_TOOL_ALLOWLIST`'s call graph. `MCP_TRANSPORT=stdio CHODA_BACKEND=postgres` is **rejected at boot** (`requireBackendForTransport`); the narrow PG facade is missing every stdio-only method, so pairing them would fail at first tool call.

Standing rule: PG surface = remote allowlist's call graph + OAuth. Expanding the allowlist requires three coordinated edits in the same PR — (1) add the tool name to `REMOTE_TOOL_ALLOWLIST`, (2) add the methods it calls to `RemoteOperations`, (3) implement those methods on `PostgresTaskService` + any missing repos/migrations. Adding a tool without (2)+(3) → tool registers but throws at runtime when called over HTTP. See ADR-026 §Per-tool scoping standing rule.

## MCP OAuth Mode (ADR-034 — supersedes ADR-027)

When `claude.ai`'s connector UI is the target client, static bearer is unsupported — flip on `MCP_OAUTH_MODE=1`. Identity, login, consent, and token issuance live in **Keycloak** (`https://id.choda.dev`); choda-deck is a thin proxy + resource server. It no longer mints or stores tokens (ADR-027's `oauth_*` tables are gone).

**Why proxy, not a clean external AS:** the claude.ai *web* connector ignores external `authorization_endpoint`/`token_endpoint`/`registration_endpoint` from metadata and hardcodes them on the MCP origin ([anthropics/claude-ai-mcp#82](https://github.com/anthropics/claude-ai-mcp/issues/82), closed not-planned). So the endpoints stay on-origin and proxy to Keycloak:
- `GET /authorize` → 302 to Keycloak `…/protocol/openid-connect/auth` (browser logs in + consents at Keycloak)
- `POST /token` → forwards the grant to Keycloak `…/protocol/openid-connect/token`, returns its response verbatim
- `POST /register` → returns the pinned Keycloak public client (no live DCR — Keycloak's anonymous DCR is off by default)
- `POST /mcp` → validates the Keycloak JWT (JWKS signature from `…/protocol/openid-connect/certs`, `iss`/`aud`/`azp`/`exp`); 401 → `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`

Keycloak setup (one-time, per realm):
- Register a **public** client (`token_endpoint_auth_method=none`, PKCE S256) → its id is `MCP_OIDC_CLIENT_ID`.
- Add `https://claude.ai/api/mcp/auth_callback` to the client's Valid Redirect URIs.
- Confirm the issued access token's `aud`/`azp` matches `MCP_OIDC_AUDIENCE` (Keycloak lacks full RFC 8707 — map an audience client-scope if needed).

Operational notes:
- **CF WAF allowlist `160.79.104.0/21` applies to `/mcp` path ONLY.** `/authorize`, `/token`, `/register`, `/.well-known/*` must stay globally reachable — they're hit by the user's browser, not the broker.
- **`id.choda.dev` is on the `/mcp` hot path** — JWKS is cached (refresh-on-unknown-kid), so brief Keycloak downtime tolerates existing tokens, but a sustained outage blocks new token validation.
- **Collapses to a pure resource server** (drop the proxy routes, keep JWT validation) the day claude.ai web honors external authorization servers (#82).
