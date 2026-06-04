---
type: decision
title: "ADR-034: Keycloak-backed HTTP auth via on-origin OAuth proxy (supersedes ADR-027)"
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/mcp/http-transport.ts
    commitSha: e63f13d4a44859089a724230a4553e2b4370ca4f
  - path: src/adapters/mcp/server-bootstrap.ts
    commitSha: e63f13d4a44859089a724230a4553e2b4370ca4f
  - path: src/adapters/mcp/oauth/authorize.ts
    commitSha: e63f13d4a44859089a724230a4553e2b4370ca4f
  - path: src/adapters/mcp/oauth/token.ts
    commitSha: e63f13d4a44859089a724230a4553e2b4370ca4f
  - path: src/adapters/mcp/oauth/register.ts
    commitSha: e63f13d4a44859089a724230a4553e2b4370ca4f
  - path: src/adapters/mcp/oauth/discovery.ts
    commitSha: e63f13d4a44859089a724230a4553e2b4370ca4f
  - path: src/core/domain/repositories/oauth-repository.ts
    commitSha: e63f13d4a44859089a724230a4553e2b4370ca4f
  - path: src/core/domain/repositories/schema.ts
    commitSha: e63f13d4a44859089a724230a4553e2b4370ca4f
  - path: docs/knowledge/adr-027-minimal-self-hosted-oauth-2-0-dcr-for-claude-ai-connector-registration.md
    commitSha: e63f13d4a44859089a724230a4553e2b4370ca4f
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
---

> AI-Context: [[adr-027-minimal-self-hosted-oauth-2-0-dcr-for-claude-ai-connector-registration|ADR-027]] hand-rolled a full OAuth 2.0 authorization server inside the HTTP transport (DCR + PKCE + authorize/token/refresh + a pre-shared consent password + an `oauth_tokens` table) **because** the claude.ai connector requires OAuth on the MCP origin. This ADR keeps that on-origin endpoint surface but **moves identity, login, consent, and token issuance to Keycloak** (`https://id.choda.dev`). choda-deck stops being an identity store and becomes a **thin OAuth proxy + resource server**: `/authorize` and `/token` proxy to Keycloak, `/mcp` validates Keycloak-issued JWTs via JWKS. The hand-rolled token store, PKCE math, refresh rotation, and consent-password gate are **deleted**. stdio mode is untouched.

## Context

ADR-027 shipped a self-hosted OAuth AS so the claude.ai connector could register and consent against `mcp.choda.dev`. It works, but it makes choda-deck its own identity provider: a single shared consent password instead of real accounts, hand-rolled PKCE/refresh-rotation that fails as a silent "Disconnected" when subtly wrong, and an `oauth_tokens`/`oauth_auth_codes`/`oauth_clients` table family to maintain. Butter already runs **Keycloak at `https://id.choda.dev`** — the identity concerns ADR-027 hand-rolled are exactly what Keycloak exists to own.

**The constraint that shapes everything: the claude.ai *web* client cannot use an external authorization server.** Verified against Anthropic's own tracker — [anthropics/claude-ai-mcp#82](https://github.com/anthropics/claude-ai-mcp/issues/82) (opened 2026-03-04, **closed "not planned"**): the claude.ai web connector **ignores** `authorization_endpoint` / `token_endpoint` / `registration_endpoint` from RFC 9728 / RFC 8414 metadata and instead hardcodes `POST /register`, `GET /authorize`, `POST /token` on the **MCP server's own origin**. It behaves like the old 2025-03-26 MCP spec. Claude Code CLI and ChatGPT honor the external-AS indirection; **claude.ai web does not, and Anthropic will not fix it.** (A vendor blog claims the opposite; it is discounted — it contradicts Anthropic's reproduced-and-closed issue.)

Therefore the architecturally-clean target — "choda-deck is a pure resource server, Keycloak is the external AS named in `authorization_servers`" — **is not reachable for the claude.ai web client today.** The HTTP-mode client for choda-deck is the claude.ai connector (confirmed with Butter, 2026-06-04). So the AS endpoints must remain co-hosted on choda-deck's origin; only their *internals* change.

## Options considered

| Option | Pro | Con |
|---|---|---|
| A. Status quo — keep ADR-027 self-issued AS | Already shipped, works | choda-deck is its own IdP: shared-password consent, hand-rolled PKCE/refresh spec-traps, `oauth_*` tables; no real accounts; duplicates what Keycloak already provides |
| B. **Clean external AS** — choda-deck = pure resource server, Keycloak named in `authorization_servers`, claude.ai redirected straight to `id.choda.dev` | Spec-correct, zero on-origin AS code, smallest surface | **Blocked for claude.ai web by [#82](https://github.com/anthropics/claude-ai-mcp/issues/82) (closed not-planned).** claude.ai web ignores the external endpoints and 404s on the MCP origin. Only viable once #82 is fixed |
| C. **On-origin OAuth proxy to Keycloak** (CHOSEN) | Keeps the endpoint surface claude.ai web hardcodes, but Keycloak owns login/consent/accounts/token issuance; deletes hand-rolled token store + PKCE + refresh + consent password; collapses to Option B the day #82 is fixed | Proxy glue on `/authorize` + `/token` (+ `/register` or a pinned client) stays on-origin; PKCE must be passed through end-to-end; small impedance-matching to Keycloak quirks (DCR off by default, RFC 8707) |
| D. `oauth_cimd` / `oauth_anthropic_creds` | Avoids DCR | Same as ADR-027's analysis — extra ceremony / manual email round-trip for a 1-user server; doesn't remove the on-origin redirect requirement for claude.ai web |

## Decision

**Chosen: Option C — on-origin OAuth proxy to Keycloak.** choda-deck keeps hosting the OAuth endpoints claude.ai web hardcodes, but each becomes a thin pass-through to Keycloak (`https://id.choda.dev/realms/<realm>`); `/mcp` validates Keycloak-issued JWTs. Both transports stay: **stdio is unchanged** (trusted local, no auth, full tool surface).

### Endpoint mapping (on choda-deck origin → Keycloak)

| Endpoint (origin) | New behavior |
|---|---|
| `GET /authorize` | **302 redirect** to Keycloak `…/protocol/openid-connect/auth`, forwarding `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `state`, `scope`. The user logs in + consents **at Keycloak** — the ADR-027 consent-password screen is deleted. |
| `POST /token` | **Forward** the `authorization_code` / `refresh_token` grant to Keycloak `…/protocol/openid-connect/token`; return Keycloak's `{access_token, refresh_token, expires_in, id_token}` verbatim. No local code/token issuance. |
| `POST /register` | Proxy RFC 7591 DCR to Keycloak `…/clients-registrations/openid-connect` **OR** pin a single pre-registered client and serve its `client_id` (decision below). |
| `GET /.well-known/oauth-protected-resource` | Retained; advertises `id.choda.dev` realm as `authorization_servers` (harmless for claude.ai web, correct for CLI/ChatGPT). |
| `GET /.well-known/oauth-authorization-server` | Proxy/mirror Keycloak's realm discovery so metadata stays consistent for clients that do read it. |
| `POST /mcp` | `verifyOAuthBearer` (`http-transport.ts:247`) **validates a Keycloak JWT** — JWKS signature (`…/protocol/openid-connect/certs`, cached), `iss` = realm issuer, `aud`/`azp`, `exp`. Replaces the `oauth_tokens` DB lookup. |

### Deleted (no longer choda-deck's job)

- `src/adapters/mcp/oauth/token.ts` token/refresh issuance + `pkce.ts` verification (PKCE is now verified **by Keycloak**; choda-deck only forwards `code_verifier`).
- `src/adapters/mcp/oauth/consent-template.ts` + the pre-shared consent password (`MCP_OAUTH_CONSENT_PASSWORD_FILE`) — Keycloak owns login/consent.
- `oauth_tokens` + `oauth_auth_codes` tables and the issuance half of `OAuthRepository`. `oauth_clients` is dropped **iff** we pin a static Keycloak client; kept only if we proxy live DCR and need a local client map.

### Open sub-decisions (resolve during implementation)

1. **DCR proxy vs. pinned client.** Keycloak's anonymous Dynamic Client Registration is **disabled by default** (RFC 7591 endpoint exists at `…/clients-registrations/openid-connect` but requires an initial-access-token or an enabled anonymous policy). Two paths: (a) enable anonymous DCR on the realm and proxy `/register`; (b) pre-register one Keycloak client for the claude.ai connector and have `/register` return its fixed `client_id` (simpler, 1-user-appropriate, no anonymous-DCR attack surface). **Lean: (b) pinned client.**
2. **RFC 8707 audience binding.** Keycloak does not fully implement RFC 8707 Resource Indicators (it uses a proprietary `audience`/client-scope mechanism). MCP clients send a `resource` param; confirm Keycloak issues a token whose `aud`/`azp` choda-deck can validate, or map `resource`→Keycloak audience client-scope. **Smoke-test, do not assume.**
3. **Static bearer (`MCP_HTTP_TOKEN`).** Keep as an orthogonal fallback for non-claude.ai / scripted callers (default: keep) or remove. Independent of Keycloak.
4. **Allowlist scoping.** Today any valid token = full `REMOTE_TOOL_ALLOWLIST` surface. Keycloak realm roles/client scopes now make per-tool scoping *possible*; decide whether v1 maps roles→tools in `verifyOAuthBearer` or stays all-or-nothing. **Lean: all-or-nothing v1, leave a `/* TBD */` seam.**

### Keycloak instance

- Base: `https://id.choda.dev`, realm `<realm>` (TBD — instance returned HTTP 530 / Cloudflare origin-unreachable at ADR time; confirm realm + endpoints when reachable).
- Endpoints (standard Keycloak OIDC): `…/realms/<realm>/protocol/openid-connect/{auth,token,certs}`, discovery at `…/realms/<realm>/.well-known/openid-configuration`, DCR at `…/realms/<realm>/clients-registrations/openid-connect`.
- Client secret (if confidential client) → `sensitive_information/keycloak-client-secret.txt` (gitignored), referenced by path, never inlined (per CLAUDE.md sensitive-data rule).

### Env config (`buildOAuthConfig`, `server-bootstrap.ts:178`)

Replace the ADR-027 consent-password vars with Keycloak config:

| Old (ADR-027) | New (ADR-034) |
|---|---|
| `MCP_OAUTH_CONSENT_PASSWORD_FILE` | *(removed)* |
| `MCP_OAUTH_ISSUER` (self) | `MCP_OIDC_ISSUER` = `https://id.choda.dev/realms/<realm>` |
| — | `MCP_OIDC_AUDIENCE` (expected `aud`/`azp`) |
| — | `MCP_OIDC_CLIENT_ID` (pinned connector client) |
| — | `MCP_OIDC_CLIENT_SECRET_FILE` (if confidential) |
| `MCP_OAUTH_MODE=1` | retained — selects Keycloak-proxy auth on HTTP |

## Consequences

- **Good:** real accounts + login + consent at Keycloak (kills the shared-password hack); no hand-rolled PKCE/refresh/token-store spec-traps to maintain; ADR-027's `oauth_*` tables shrink or vanish; the moment claude.ai web fixes [#82](https://github.com/anthropics/claude-ai-mcp/issues/82) this collapses to the clean Option-B resource-server model with near-zero rework; per-tool scoping via Keycloak roles becomes possible.
- **Bad:** a proxy still lives on-origin — not the zero-AS-code ideal, purely because of the claude.ai-web client bug; one more external runtime dependency on the `/mcp` hot path (Keycloak must be up for JWT validation — JWKS is cached, so brief Keycloak downtime tolerates existing tokens). Keycloak at `id.choda.dev` was returning 530 at ADR time — availability of that origin is now load-bearing for HTTP auth.
- **Risks:** (1) **PKCE pass-through** — choda-deck must forward `code_challenge`/`code_verifier` untouched; mangling it = silent Disconnected. (2) **RFC 8707 audience mismatch** — Keycloak's non-standard audience handling may yield a token choda-deck rejects; smoke-test before cutover. (3) **JWKS rotation** — cache `…/certs` with a refresh-on-unknown-kid path or signature validation breaks on Keycloak key rollover. (4) **[#82](https://github.com/anthropics/claude-ai-mcp/issues/82) regressing further** — if claude.ai web changes hardcoded paths again, the proxy routes must track them.

## Revisit when

- **claude.ai web fixes [#82](https://github.com/anthropics/claude-ai-mcp/issues/82)** (honors external `authorization_servers`) → delete the proxy routes, keep only JWT validation + protected-resource metadata pointing at Keycloak = Option B. This ADR's proxy becomes legacy.
- **A second human / non-claude.ai client** → Keycloak already supports it; just add realm users/roles. The per-tool allowlist scoping seam activates here.
- **Keycloak adds standard RFC 8707** → drop the `resource`→audience mapping shim.
- **Keycloak at `id.choda.dev` proves flaky** → consider short-lived token caching / introspection fallback, or reconsider availability coupling on `/mcp`.

## Related

- **Supersedes [[adr-027-minimal-self-hosted-oauth-2-0-dcr-for-claude-ai-connector-registration]]** — same problem (claude.ai connector auth on-origin), different identity backend (Keycloak vs. hand-rolled). Endpoint *surface* preserved; issuance/consent/storage moved out.
- **Builds on [[ADR-026-dual-transport-mcp-server]]** — HTTP transport, `REMOTE_TOOL_ALLOWLIST`, narrow `RemoteOperations` PG surface; unchanged. Allowlist scoping sub-decision lives at this boundary.
- **Touches [[ADR-030-dual-backend-sync]]** — `OAuthRepository` was built per-backend in `buildOAuthConfig`; its shrink/removal touches both SQLite + PG wiring.
- **Implemented in:** TASK-1039.
- **Evidence:** [anthropics/claude-ai-mcp#82](https://github.com/anthropics/claude-ai-mcp/issues/82) (external-AS not honored by claude.ai web, closed not-planned, 2026-03-04); [Keycloak MCP authz-server docs](https://www.keycloak.org/securing-apps/mcp-authz-server) (DCR disabled by default; RFC 8707 gap).
- **Spec references:** RFC 6749, RFC 7591 (DCR), RFC 7636 (PKCE), RFC 8414 (AS metadata), RFC 8707 (Resource Indicators — partial in Keycloak), RFC 9728 (Protected Resource Metadata), OIDC Discovery.
