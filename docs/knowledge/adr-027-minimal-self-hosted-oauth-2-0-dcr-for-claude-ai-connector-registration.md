---
type: decision
title: "ADR-027: Minimal self-hosted OAuth 2.0 + DCR for claude.ai connector registration"
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/mcp/http-transport.ts
    commitSha: 14d986b8b810b0c074c583385cb1b49142b2cf53
  - path: src/core/domain/repositories/schema.ts
    commitSha: 14d986b8b810b0c074c583385cb1b49142b2cf53
  - path: src/core/domain/repositories/oauth-repository.ts
    commitSha: 14d986b8b810b0c074c583385cb1b49142b2cf53
  - path: src/adapters/mcp/server-bootstrap.ts
    commitSha: 14d986b8b810b0c074c583385cb1b49142b2cf53
  - path: src/adapters/mcp/oauth/discovery.ts
    commitSha: 14d986b8b810b0c074c583385cb1b49142b2cf53
  - path: src/adapters/mcp/oauth/register.ts
    commitSha: 14d986b8b810b0c074c583385cb1b49142b2cf53
  - path: src/adapters/mcp/oauth/authorize.ts
    commitSha: 14d986b8b810b0c074c583385cb1b49142b2cf53
  - path: src/adapters/mcp/oauth/token.ts
    commitSha: 14d986b8b810b0c074c583385cb1b49142b2cf53
  - path: src/adapters/mcp/oauth/pkce.ts
    commitSha: 14d986b8b810b0c074c583385cb1b49142b2cf53
  - path: src/adapters/mcp/oauth/consent-template.ts
    commitSha: 14d986b8b810b0c074c583385cb1b49142b2cf53
  - path: docs/knowledge/ADR-026-dual-transport-mcp-server.md
    commitSha: 14d986b8b810b0c074c583385cb1b49142b2cf53
createdAt: 2026-05-21
lastVerifiedAt: 2026-05-21
---

> AI-Context: ADR-026 shipped bearer-only HTTP as V1 with "OAuth is a follow-up." This is that follow-up — and it's a **forcing move**, not a graceful upgrade. The claude.ai connector UI rejects static-bearer servers entirely. To register at claude.ai (Step 7 of the remote-deploy plan), choda-deck must speak OAuth 2.0 with Dynamic Client Registration (RFC 7591) co-hosted on the same origin as `/mcp`. We **hand-roll a minimal OAuth authorization server** inside the HTTP transport — no Auth0, no framework lib. The `/authorize` endpoint is gated by a **pre-shared password** because one-click consent on a public URL is equivalent to authless.

## Context

[[ADR-026-dual-transport-mcp-server]] shipped V1 of the remote MCP server with bearer-only auth behind Cloudflare Tunnel, and explicitly punted OAuth: *"V1 sequencing: ship bearer-only as v1, OAuth/DCR is a follow-up before any second human user joins."* The assumption was that bearer would carry us until a second user appeared.

That assumption broke at Step 7 of the remote-deploy plan (register choda-deck at `claude.ai` as a custom connector). Verified against Anthropic's connector docs (claude.com/docs/connectors/building/authentication, 2026-05-21) and the live UI:

- **The claude.ai connector UI's "Add custom connector" Advanced settings exposes only OAuth Client ID + Client Secret fields.** There is no custom-header / bearer field. The current bare-401 response (no `WWW-Authenticate`, no `/.well-known/oauth-authorization-server`) cannot register at all.
- **Supported auth shapes are exactly five:** `oauth_dcr` (RFC 7591 Dynamic Client Registration), `oauth_cimd` (Client ID Metadata Document), `oauth_anthropic_creds` (Anthropic holds your client_id/secret — requires emailing `mcp-support@anthropic.com`), `none` (authless), `custom_connection` (Snowflake-style — requires contacting Anthropic).
- **Static user-pasted bearer is explicitly "not yet supported"** (tracked in `anthropics/claude-ai-mcp#112`).
- **Pure machine-to-machine `client_credentials` grant is not supported either** — every connection requires user consent + a redirect to `https://claude.ai/api/mcp/auth_callback`. There is no silent service-to-service flow even with OAuth.

The Cloudflare-Access escape hatch is also closed: the Anthropic connector broker calls from a fixed egress range (`160.79.104.0/21`), presents no interactive login, and cannot send the `CF-Access-Client-Id` service-token header. Putting CF Access in front of `/mcp` produces the same 403 that bearer-only produces 401 — confirmed in Anthropic's own docs: *"a WAF in front of your identity provider can break the flow even when your MCP server is reachable."*

Anthropic's recommended pattern matches our infra exactly: *"if you control both hosts, serve the MCP endpoint and the authorization server behind a single custom domain that can route both /.well-known/* and your MCP path."* We own `choda.dev` + a single tunnel — co-host on `mcp.choda.dev`.

**Net:** the real choices have collapsed to (a) real OAuth, or (b) truly authless. Authless on a public URL exposes the DB to anyone who guesses the hostname, which is unacceptable even with the vulgar-word-obscured name. Real OAuth it is.

**Single-user note.** Butter is the only human. The OAuth user-flow exists not because we need multi-user identity, but because the connector spec mandates a consent redirect on every register — even for a 1-user server. This shapes the design: trivial consent UI, single shared password (not full account system), no per-user scopes, no email/social login.

## Options considered

| Option | Pro | Con |
|---|---|---|
| A. Stay bearer-only, use `mcp-remote` shim on each client | Zero server change | Pushes complexity to every client; mobile (`claude.ai` only) can't add custom connectors via shim; defeats the public-mobile-access goal of ADR-026 |
| B. External IdP (Auth0, Clerk, Authentik) | Spec-correctness out of box; rotation handled | External runtime dep on a self-hosted personal-infra project; still write `/.well-known/*` glue on `mcp.choda.dev` for resource metadata; still need DCR adapter since the connector requires it on the resource origin; tenant/JWKS config to maintain |
| C. OAuth framework lib (`@node-oauth/oauth2-server`, `node-oidc-provider`) | Spec-correctness on PKCE / token / refresh | **No mainstream Node OAuth lib ships RFC 7591 DCR** — would write model adapters + DCR shim regardless; framework brings opinionated abstractions for multi-tenant flows we don't need; ~1500 LOC of dep surface for a 5-endpoint need |
| D. **Hand-roll minimal OAuth + DCR, self-hosted in HTTP transport** | One bundle, KISS, ~5 small files (<300 LOC each per `.claude/rules/typescript.md`); full control of consent UX; PKCE/token/rotation are localized small bits | Spec-trap surface (PKCE math, refresh rotation, RFC 6749 error shapes) — bugs surface as silent "Disconnected" in the connector UI; mitigation = conformance test suite, non-negotiable |
| E. Authless + Cloudflare Access | No app code | **Verified broken** — Anthropic broker can't satisfy CF Access challenge. Documented dead-end in Anthropic's own auth docs |
| F. Authless + IP allowlist `160.79.104.0/21` at CF edge | No app code | Sole access control is an IP allowlist; `/mcp` is otherwise globally open; Anthropic's broker IP range is documented but not contractually stable; weaker security posture than even bearer |
| G. Authless + obscure URL only | Trivial | The hostname is `mcp.choda.dev` — guessable + DNS-discoverable. Security-by-obscurity for a write-capable DB is unacceptable |
| H. `oauth_cimd` (Client ID Metadata Document) | Avoids per-client registration storage | Anthropic docs recommend CIMD only for high-traffic directory servers to avoid registration bloat — non-issue for a 1-user server. Extra ceremony for no benefit |
| I. `oauth_anthropic_creds` (Anthropic-managed client creds) | Anthropic holds the secret | Requires emailing `mcp-support@anthropic.com` per server, async turnaround; couples deploy lifecycle to an external manual process; rotation = email round-trip |

## Decision

**Chosen: Option D — hand-roll a minimal OAuth 2.0 authorization server with Dynamic Client Registration (RFC 7591), co-hosted with `/mcp` on `mcp.choda.dev`. Three sub-decisions resolved in [[CONV-1779344247258-9]]:**

1. **Self-host, not external IdP.** Auth0 trades one OAuth build for a different integration build (claims mapping, JWKS, tenant config) AND adds a third-party runtime dep to a self-hosted personal-infra project. The `/.well-known/*` glue on `mcp.choda.dev` is unavoidable either way.
2. **Hand-roll, not framework lib.** No mainstream Node OAuth lib ships RFC 7591 DCR; model adapters get written either way. The risky spec bits are small and localized — PKCE check is ~10 lines, refresh rotation is one transaction, `invalid_grant` is a single RFC 6749 response shape. Silent-Disconnected risk mitigated by a conformance test suite, not a heavy framework.
3. **`/authorize` MUST be gated by a pre-shared password.** One-click consent makes the endpoint effectively authless — Anthropic's broker redirects the **end user's browser** (not the broker) to `/authorize`, so any stranger who finds `mcp.choda.dev` can register a connector at `claude.ai` and self-consent to a valid token. Password is the single-user equivalent of an account system.

### Endpoints

Added to the existing `POST /mcp` server in [[http-transport.ts]]:

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 authorization server metadata |
| GET | `/.well-known/oauth-protected-resource` | RFC 9728 protected resource metadata |
| POST | `/register` | RFC 7591 DCR — accepts JSON, mints `client_id`, persists |
| GET | `/authorize` | Renders consent screen gated by pre-shared password; issues PKCE-bound auth code on submit |
| POST | `/token` | Exchanges auth code → `{access_token, refresh_token, expires_in}`; refresh rotation; `invalid_grant` on expired/replayed |

`/mcp` 401 responses gain:
```
WWW-Authenticate: Bearer resource_metadata="https://mcp.choda.dev/.well-known/oauth-protected-resource"
```

### Schema

Three new tables in [[schema.ts]]:

```sql
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, -- JSON array
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_auth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE oauth_tokens (
  access_token TEXT PRIMARY KEY,
  refresh_token TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
```

Token TTLs: **access = 1h, refresh = 30d, single-use refresh with rotation.** Rotation = **mark-old-revoked + insert-new in one transaction** (not delete-old). Revoked rows are kept so a replayed refresh token can be detected — per OAuth 2.1 §4.13.2, a presented-but-already-revoked refresh implies token theft and MUST revoke the entire descendant chain for that `client_id`. "Delete-old" makes that detection impossible (the replayed token would just look unknown).

### Auth model

Three layers, each catching what the others can't:

1. **Pre-shared password on `/authorize`.** Stored as SHA-256 hex digest at `sensitive_information/oauth-consent-password.txt` (gitignored per CLAUDE.md sensitive-data rules). Hash comparison via `crypto.timingSafeEqual`. Rejects submissions without the password — prevents URL-finder self-consent. **Guardrail: the plaintext password MUST be ≥32 chars high-entropy** (password-manager generated, not memorable). SHA-256 is a fast hash, not a KDF — it gives a fingerprint, not work-factor protection. A short/memorable password + leaked file = trivially brute-forceable. See "Revisit when" for the scrypt/argon2 upgrade trigger.
2. **Cloudflare WAF allowlist `160.79.104.0/21` on `/mcp` path ONLY** (defense in depth). The Anthropic broker is the only legitimate caller of `/mcp`, and its egress range is documented. `/authorize`, `/token`, `/register`, `/.well-known/*` MUST stay globally reachable — they're hit by the **user's browser**, not the broker, and an allowlist there would break the consent redirect.
3. **Bearer token validation against `oauth_tokens` table** on `/mcp` calls. Replaces the V1 `MCP_HTTP_TOKEN` check when OAuth mode is on (env-flag selectable — legacy mode kept for stdio-bound testing).

### File layout

```
src/adapters/mcp/
├── http-transport.ts                   ← UPDATED: route dispatch for /.well-known/*, /register, /authorize, /token
├── oauth/                              ← NEW
│   ├── discovery.ts                    ← /.well-known/* responders
│   ├── register.ts                     ← POST /register (DCR)
│   ├── authorize.ts                    ← GET /authorize + consent gate
│   ├── token.ts                        ← POST /token + refresh rotation
│   ├── pkce.ts                         ← sha256+base64url verify
│   ├── consent-template.ts             ← HTML render for the consent screen
│   └── __tests__/*.test.ts             ← conformance suite (see Test Plan in TASK-901)
└── (existing files unchanged)

src/core/domain/repositories/
├── schema.ts                           ← UPDATED: oauth_* DDL
└── oauth-repository.ts                 ← NEW: CRUD over oauth_clients/codes/tokens
```

Each new file targets <300 LOC per [[typescript-conventions]]. Composition over framework — `http-transport.ts` does route dispatch; each `oauth/*.ts` file owns one endpoint.

### Mode selection

OAuth mode is opt-in via env flag (e.g. `MCP_OAUTH_MODE=1`). V1 bearer-only path remains available for:
- Local stdio-bound testing
- Pre-OAuth-cutover production grace period

When OAuth mode is on, `MCP_HTTP_TOKEN` is ignored and `oauth_tokens` is the only valid bearer source. When OAuth mode is off, behavior is exactly V1.

## Why not others

| Option | Rejected because |
|---|---|
| A. Stay bearer-only | `claude.ai` connector UI hard-rejects static-bearer servers — Step 7 simply cannot complete |
| B. External IdP (Auth0 etc.) | Same `/.well-known` work on `mcp.choda.dev` plus a third-party runtime dep on a self-hosted project. Onboarding tax (tenant config, JWKS, claims) outweighs implementing the 5 endpoints once |
| C. OAuth framework lib | No mainstream lib ships RFC 7591 DCR — would write the adapters anyway. Framework abstractions assume multi-tenant flows we don't need; their cost is dep surface + opinionated wiring, their benefit (spec-correctness on tokens/PKCE) is replaceable by a conformance test suite |
| E. Authless + CF Access | Verified broken — the Anthropic broker can't satisfy a CF Access challenge. Documented dead-end |
| F. Authless + IP allowlist on `/mcp` | The allowlist becomes the sole control on a write-capable DB endpoint. Anthropic's broker IP range is documented but not contractually stable; one range change = open DB |
| G. Authless + obscure URL | Hostname is DNS-discoverable. Security-by-obscurity is not a control |
| H. `oauth_cimd` (CIMD) | Designed for high-traffic directory servers to avoid registration bloat. Single-user server has zero registration bloat — extra ceremony for no benefit |
| I. `oauth_anthropic_creds` | Manual email round-trip with `mcp-support@anthropic.com` per server. Couples deploy + rotation lifecycle to an external human process. Acceptable as a fallback if we can't ship OAuth ourselves; not acceptable as primary when DCR works out of the box |
| One-click consent (variant of D, no password) | Public URL + automatic consent = stranger can register a connector at `claude.ai`, follow the redirect to `mcp.choda.dev/authorize`, click approve, mint a token. OAuth becomes theater |

## Consequences

- **Good:**
  - Unblocks Step 7 — the `claude.ai` connector UI registers cleanly via the spec-blessed DCR path.
  - Co-hosted on `mcp.choda.dev` — Anthropic's recommended pattern; no second domain to register/route.
  - Self-contained in choda-deck — no external IdP runtime dep, no third-party email round-trip, portable if Cloudflare Tunnel is ever swapped.
  - Three-layer security model: password-gated consent + broker IP allowlist + token expiry. Each layer catches a different failure mode.
  - Per-client tokens with rotation — leaked token bounds the blast radius to one client and one refresh window, not "everything until rotated" (the V1 bearer failure mode).
- **Bad:**
  - Real OAuth surface to maintain (5 endpoints, 3 tables, consent UI). Not a 30-minute change — a focused multi-session build (split into subtasks for queue-safety per [[TASK-901]] auto-safe feedback).
  - HTML consent template is the first user-facing UI in choda-deck's HTTP transport. Trivial markup, but introduces a "templates" concept that didn't exist before. Keep it inline / no template engine.
  - Password rotation = update file + restart pod. No in-app rotation UI (out of scope for single-user).
  - Failure mode for bugs is silent "Disconnected" in `claude.ai` connector list — the UI gives almost no diagnostic. Conformance test suite is mandatory, not optional.
- **Risks:**
  - **Spec-correctness bugs in PKCE / refresh / `invalid_grant` shape** → silent Disconnected. Mitigation: per-endpoint unit tests covering happy + bad-PKCE + expired-code + replayed-refresh + missing-password (see [[TASK-901]] Test Plan).
  - **Anthropic broker IP range changes** → defense-in-depth WAF allowlist on `/mcp` breaks legitimate traffic. Mitigation: allowlist is defense-in-depth, not primary auth — removing it just falls back to OAuth-only, which still works. Documented in operational runbook.
  - **Anthropic adds `static_bearer` support in connector UI** → this whole OAuth build becomes optional/legacy. Acceptable — the OAuth path is still spec-correct and more secure than static bearer.
  - **DCR client registration spam** if the endpoint is ever scraped → bloat in `oauth_clients`. Mitigation: 1-user server, expected client count is single-digit forever. Add a hard cap (e.g. 50 clients) with a 429 response if it ever matters.
  - **Consent password leaked** (committed, shared, brute-forced) → stranger can mint tokens. Mitigation: `sensitive_information/` is gitignored; password rotation is file-edit + restart; rate-limit `/authorize` attempts.
  - **Auth code interception** → mitigated by PKCE (mandatory `S256`), 60s TTL, single-use semantics.
  - **Stale refresh tokens** across pod restarts → tokens live in SQLite, survive restarts; only revoked-by-rotation tokens become invalid.

## Impact

- **Files/modules changed:**
  - [[http-transport.ts]] — extend route dispatch with `/.well-known/*`, `/register`, `/authorize`, `/token`; update 401 path with `WWW-Authenticate` header; bearer validation reads `oauth_tokens` when OAuth mode is on
  - [[schema.ts]] — add `oauth_clients`, `oauth_auth_codes`, `oauth_tokens` DDL with migration version bump
  - [[server-bootstrap.ts]] — read `MCP_OAUTH_MODE` env, wire `OAuthRepository` into HTTP transport options
  - `src/adapters/mcp/oauth/` — NEW directory (`discovery.ts`, `register.ts`, `authorize.ts`, `token.ts`, `pkce.ts`, `consent-template.ts`, `__tests__/`)
  - `src/core/domain/repositories/oauth-repository.ts` — NEW
  - `src/adapters/mcp/__tests__/http-transport.test.ts` — extend with OAuth conformance suite (or split out as `oauth/__tests__/*`)
  - `CLAUDE.md` — env var table gains `MCP_OAUTH_MODE`; operational notes on consent password file and CF WAF allowlist scope
  - `.gitignore` — confirm `sensitive_information/` is ignored (per global CLAUDE.md rules — likely already in)
- **Dependencies added:** **none.** PKCE uses Node's built-in `crypto.createHash('sha256')` + base64url encoding. HTML consent screen is a template literal. SQLite handles persistence via existing `better-sqlite3`.
- **Migration needed:**
  - SQLite schema migration adds 3 tables (no data backfill — empty on first boot)
  - Existing bearer-only deployments stay on V1 path until `MCP_OAUTH_MODE=1` flipped
  - Consent password file must be provisioned before flipping the flag

## Revisit when

- **Anthropic adds `static_bearer` to the connector UI** → re-evaluate whether to keep OAuth as primary or fall back to bearer + this becomes legacy / pre-secured-multi-user path
- **A second human user joins** → graduate consent gate from "one password" to per-user accounts (or move to `oauth_anthropic_creds` + per-user Anthropic identities). Today: one Butter, one shared password
- **Per-tool token scopes become desirable** (e.g. read-only mobile token vs. read-write desktop token) → extend `oauth_tokens` schema with `scopes` column and check at `/mcp` dispatch
- **DCR scraping ever observed** → add per-IP rate limits + hard client-count cap with 429 response
- **The Anthropic broker IP range changes** → update WAF allowlist; if it changes often, drop the allowlist (defense-in-depth only — OAuth alone is sufficient)
- **Consent password ever leaks or is brute-forced** → rotate + add per-IP rate limiting on `/authorize`; consider one-time approve tokens (admin pre-generates) as an alternative model
- **Multi-user lands, OR the consent password file leaves `sensitive_information/` (e.g. into a k8s Secret readable by additional humans), OR the password becomes memorable instead of password-manager generated** → upgrade SHA-256 → `crypto.scryptSync` (built-in, no dep) with OWASP-standard `salt$N$r$p$keylen$hash` encoding. argon2id (via npm) is the OWASP first-choice but adds a dep. Researched in [[CONV-1779417384922-1]]
- **Postgres migration ships** ([[INBOX-366]]) → `oauth_*` tables move with the rest; no special handling needed
- **A non-Claude OAuth client** (custom MCP client, scripted automation) needs to register → confirm DCR works for arbitrary RFC 7591 clients (it should — that's the spec); add docs

## Related

- **Supersedes V1 sequencing of [[ADR-026-dual-transport-mcp-server]]** — that ADR's "Revisit when: a second human user / agent needs different scopes → graduate to OAuth 2.1 / DCR" condition fires earlier than expected, triggered by Anthropic's connector UI constraints rather than a second user. The transport architecture (single binary, stateless HTTP, Cloudflare Tunnel) is unchanged
- **Decided in:** [[CONV-1779344247258-9]] — three forks resolved (self-host vs IdP, hand-roll vs lib, consent gate model)
- **Implemented in:** [[TASK-901]] — full AC, schema DDL, conformance test plan, smoke steps
- **Builds on:** [[ADR-026-dual-transport-mcp-server]] (HTTP transport + Cloudflare Tunnel infra), [[ADR-018-knowledge-layer]] (this ADR follows the knowledge-layer staleness contract)
- **Spec references:**
  - RFC 6749 — OAuth 2.0 Authorization Framework
  - RFC 7591 — OAuth 2.0 Dynamic Client Registration
  - RFC 7636 — PKCE
  - RFC 8414 — OAuth 2.0 Authorization Server Metadata
  - RFC 9728 — OAuth 2.0 Protected Resource Metadata
- **Anthropic docs:** `claude.com/docs/connectors/building/authentication`
- **Anthropic broker egress range:** `160.79.104.0/21` (documented; used for defense-in-depth WAF allowlist on `/mcp` only)
- **Tracking issue (upstream):** `anthropics/claude-ai-mcp#112` — request for static-bearer support in connector UI
