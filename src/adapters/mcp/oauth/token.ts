import type {
  OAuthAccessToken,
  OAuthOperations
} from '../../../core/domain/interfaces/oauth-repository.interface'
import { verifyPkceS256 } from './pkce'

// ADR-027: POST /token implements two RFC 6749 grants:
//   - authorization_code → exchange a single-use PKCE-bound code for tokens
//   - refresh_token      → rotate via OAuthRepository (replay detected → chain
//                          revoked → invalid_grant)
// All errors follow RFC 6749 §5.2 (JSON body { error, error_description }).

export interface TokenResult {
  status: number
  body: object
}

const ACCESS_TTL_SECONDS = 60 * 60 // 1h
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30 // 30d

export async function handleToken(
  repo: OAuthOperations,
  form: URLSearchParams
): Promise<TokenResult> {
  const grantType = form.get('grant_type')
  if (grantType === 'authorization_code') return handleCodeGrant(repo, form)
  if (grantType === 'refresh_token') return handleRefreshGrant(repo, form)
  return errorResponse(
    400,
    'unsupported_grant_type',
    'only authorization_code and refresh_token are supported'
  )
}

async function handleCodeGrant(
  repo: OAuthOperations,
  form: URLSearchParams
): Promise<TokenResult> {
  const code = form.get('code')
  const redirectUri = form.get('redirect_uri')
  const clientId = form.get('client_id')
  const codeVerifier = form.get('code_verifier')
  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return errorResponse(400, 'invalid_request', 'missing required parameter')
  }

  // Consume is atomic — the code is burned even if validation fails below.
  // That's intentional: single-use semantics enforced at the storage layer.
  const consumed = await repo.consumeAuthCode(code)
  if (!consumed) return errorResponse(400, 'invalid_grant', 'code unknown or already used')
  if (Date.parse(consumed.expiresAt) <= Date.now()) {
    return errorResponse(400, 'invalid_grant', 'code expired')
  }
  if (consumed.clientId !== clientId) {
    return errorResponse(400, 'invalid_grant', 'client_id does not match code')
  }
  if (consumed.redirectUri !== redirectUri) {
    return errorResponse(400, 'invalid_grant', 'redirect_uri does not match code')
  }
  if (!verifyPkceS256(codeVerifier, consumed.codeChallenge)) {
    return errorResponse(400, 'invalid_grant', 'PKCE verifier does not match challenge')
  }

  const tokens = await repo.createTokens({
    clientId,
    accessTtlSeconds: ACCESS_TTL_SECONDS,
    refreshTtlSeconds: REFRESH_TTL_SECONDS
  })
  return tokenSuccess(tokens)
}

async function handleRefreshGrant(
  repo: OAuthOperations,
  form: URLSearchParams
): Promise<TokenResult> {
  const refreshToken = form.get('refresh_token')
  if (!refreshToken) return errorResponse(400, 'invalid_request', 'missing refresh_token')

  const result = await repo.rotateRefresh(refreshToken, {
    accessTtlSeconds: ACCESS_TTL_SECONDS,
    refreshTtlSeconds: REFRESH_TTL_SECONDS
  })
  if (!result.ok) {
    const description =
      result.error === 'replay_detected'
        ? 'refresh token replayed; chain revoked'
        : 'refresh token unknown or expired'
    return errorResponse(400, 'invalid_grant', description)
  }
  return tokenSuccess(result.tokens)
}

function tokenSuccess(tokens: OAuthAccessToken): TokenResult {
  return {
    status: 200,
    body: {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: tokens.refreshToken
    }
  }
}

function errorResponse(status: number, error: string, errorDescription: string): TokenResult {
  return {
    status,
    body: { error, error_description: errorDescription }
  }
}
