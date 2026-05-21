import { createHash, timingSafeEqual } from 'crypto'
import { Buffer } from 'buffer'

// RFC 7636 PKCE S256 verifier. The client sends a random `code_verifier` at
// /token time; the server compares its hash against the `code_challenge` it
// stored at /authorize time. We accept only S256 — `plain` is disallowed (the
// schema CHECK enforces this on the storage side, and Anthropic's broker
// uses S256).
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false
  const computed = computeChallengeS256(verifier)
  const a = Buffer.from(computed, 'utf8')
  const b = Buffer.from(challenge, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function computeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url')
}
