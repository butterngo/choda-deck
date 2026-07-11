// TASK-1330 — per-profile token for the companion capture bridge. The read/sync
// endpoints rely on the 127.0.0.1 bind alone, but POST /capture performs writes
// triggered from a browser extension: loopback bind does NOT stop a malicious web
// page's fetch to localhost (a simple request still lands even when CORS blocks
// reading the response). The token — which a page cannot read off disk — is the
// real gate. Same reasoning as ADR-007 (english-companion loopback bridge).

import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'

export const BRIDGE_TOKEN_FILE = 'bridge-token.txt'

// 24 random bytes → 32-char base64url. Matches ADR-007's token size.
function mintToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * Resolve the capture-bridge token for this data profile, creating it on first
 * use. Persisted at `<dataDir>/bridge-token.txt` with mode 600 so other local
 * users can't read it. A present-but-empty file (truncated/corrupt) is re-minted.
 */
export function resolveBridgeToken(dataDir: string): string {
  const tokenPath = path.join(dataDir, BRIDGE_TOKEN_FILE)
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim()
    if (existing.length > 0) return existing
  } catch {
    // missing file — fall through to mint
  }
  const token = mintToken()
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(tokenPath, token, { mode: 0o600 })
  return token
}
