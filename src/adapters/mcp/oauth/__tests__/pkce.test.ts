import { describe, it, expect } from 'vitest'
import { computeChallengeS256, verifyPkceS256 } from '../pkce'

describe('PKCE S256 (ADR-027)', () => {
  // RFC 7636 Appendix B canonical test vector
  const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const rfcChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

  it('computes the RFC 7636 Appendix B canonical challenge', () => {
    expect(computeChallengeS256(rfcVerifier)).toBe(rfcChallenge)
  })

  it('verifies matching verifier + challenge', () => {
    expect(verifyPkceS256(rfcVerifier, rfcChallenge)).toBe(true)
  })

  it('rejects mismatched verifier', () => {
    expect(verifyPkceS256('a'.repeat(64), rfcChallenge)).toBe(false)
  })

  it('rejects verifier shorter than 43 chars (RFC 7636 §4.1)', () => {
    expect(verifyPkceS256('a'.repeat(42), computeChallengeS256('a'.repeat(42)))).toBe(false)
  })

  it('rejects verifier longer than 128 chars (RFC 7636 §4.1)', () => {
    const tooLong = 'a'.repeat(129)
    expect(verifyPkceS256(tooLong, computeChallengeS256(tooLong))).toBe(false)
  })

  it('produces base64url output (no +, /, or = chars)', () => {
    const out = computeChallengeS256(rfcVerifier)
    expect(out).not.toMatch(/[+/=]/)
  })
})
