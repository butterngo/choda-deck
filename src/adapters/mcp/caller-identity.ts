// TASK-2242 — who is calling the remote. The OAuth gate used to keep only
// `claims !== null` and drop the claims, so no tool could tell one Keycloak
// user from another. The gate now derives a CallerIdentity per request and
// carries it in AsyncLocalStorage, so every remote tool handler can read it
// with currentCaller() without each register() signature growing a parameter.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { JwtClaims } from './oauth/jwt-verifier'

// Keycloak realm role held by the one person who converts drafts into tasks
// and owns the laptop that syncs (TASK-2241). Members do not hold it.
export const CONVERTER_ROLE = 'choda-converter'

export interface CallerIdentity {
  member: string
  isConverter: boolean
}

// The legacy static bearer (MCP_HTTP_TOKEN) is Butter's own machine
// credential — the laptop sync loop and pre-OAuth deployments — so it keeps
// full access, exactly as before.
export const STATIC_BEARER_IDENTITY: CallerIdentity = Object.freeze({
  member: 'static-bearer',
  isConverter: true
})

export function identityFromClaims(claims: JwtClaims): CallerIdentity {
  const username = claims.preferred_username
  const member = typeof username === 'string' && username.length > 0 ? username : claims.sub
  return { member, isConverter: realmRoles(claims).includes(CONVERTER_ROLE) }
}

function realmRoles(claims: JwtClaims): string[] {
  const access = claims.realm_access
  if (typeof access !== 'object' || access === null) return []
  const roles = (access as { roles?: unknown }).roles
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : []
}

const callerStore = new AsyncLocalStorage<CallerIdentity>()

export function runAsCaller<T>(caller: CallerIdentity, fn: () => T): T {
  return callerStore.run(caller, fn)
}

// The identity of the request currently being served, or undefined outside a
// request (stdio transport, boot-time tool registration).
export function currentCaller(): CallerIdentity | undefined {
  return callerStore.getStore()
}

// TASK-2245 — the name a write is attributed to. A team member is always
// recorded as themselves, whatever name the client sent; a converter (and
// stdio, where there is no caller) keeps the client-supplied name.
export function attributedName(clientName: string): string {
  const caller = currentCaller()
  return caller && !caller.isConverter ? caller.member : clientName
}

// TASK-2245 — the member who made this remote request, or null outside one.
export function callerMemberOrNull(): string | null {
  return currentCaller()?.member ?? null
}
