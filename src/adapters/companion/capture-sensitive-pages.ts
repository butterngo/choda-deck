// TASK-3156 — pages whose purpose is to show a secret. A screenshot of one stores
// the secret as pixels (two GitHub runner-registration captures carried a live
// token, INBOX-2184), so image captures and element crops from these URLs are
// refused unless the caller says `payload.allowSensitive: true`. Kept in code,
// not config: the list is short, reviewed, and must not be silently widened.

export const CREDENTIAL_PAGE_PATTERNS: RegExp[] = [
  // GitHub self-hosted runner registration (repo + org) — shows a live token
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/settings\/actions\/runners\/new/,
  /^https:\/\/github\.com\/organizations\/[^/]+\/settings\/actions\/runners\/new/,
  // GitHub personal access tokens
  /^https:\/\/github\.com\/settings\/tokens/,
  // GitHub ssh / deploy keys
  /^https:\/\/github\.com\/settings\/(ssh\/)?keys/,
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/settings\/keys/,
  // GCP API credentials
  /^https:\/\/console\.cloud\.google\.com\/apis\/credentials/,
  // AWS IAM security credentials
  /^https:\/\/(us-east-1\.)?console\.aws\.amazon\.com\/iam\/home.*security_credentials/
]

/** The source of the first matching pattern, or null when the page is not a credential page. */
export function credentialPageRule(url: string): string | null {
  for (const re of CREDENTIAL_PAGE_PATTERNS) if (re.test(url)) return re.source
  return null
}
