---
type: gotcha
title: Every new OAuth connector client needs its callback in Keycloak Valid Redirect URIs
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/mcp/oauth/keycloak-proxy.ts
    commitSha: 95bec64328a671c14933e314a9230807f3654aa4
createdAt: 2026-10-28
lastVerifiedAt: 2026-10-28
affectedFeatureId: feature-oauth-dcr
---

## Trigger

A new remote MCP client (ChatGPT, or any connector other than claude.ai) fails to connect to `https://mcp.choda.dev/mcp` right after the login redirect, while claude.ai keeps working.

## Context

In OAuth mode (ADR-034) choda-deck is a thin proxy in front of Keycloak. `GET /authorize` forwards the client's `redirect_uri` verbatim to Keycloak, and `POST /register` returns the pinned public client (`claude-connector`, realm `demo`) echoing whatever `redirect_uris` the client sent. So registration always "succeeds" — the rejection only happens at Keycloak's authorize endpoint.

## Business rule

The pinned Keycloak client must list the callback of every connector that uses it in **Valid Redirect URIs**:

- claude.ai: `https://claude.ai/api/mcp/auth_callback`
- ChatGPT: `https://chatgpt.com/connector_platform_oauth_redirect`

## Resolution

Keycloak shows `Invalid parameter: redirect_uri` on the sign-in page. Add the client's callback to the `claude-connector` client in Keycloak and save — no choda-deck restart needed. To confirm which URI a client sends, replay `GET /authorize?...&redirect_uri=<callback>` with curl, follow the redirect, and grep the Keycloak page for `kc-error-message`; replay with the claude.ai callback as the control.

Found 2026-10-28 while connecting choda-remote to ChatGPT.
