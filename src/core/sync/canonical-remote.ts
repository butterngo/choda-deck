/**
 * Canonicalize a git remote URL into a stable identity key.
 *
 * Strips: protocol, credentials, leading/trailing slashes, `.git` suffix.
 * Lowercases: host only (path is case-sensitive on most git servers).
 *
 * SSH form `git@host:path` and URL form `scheme://[creds@]host[:port]/path`
 * both reduce to `<host-lowercase>/<path>`.
 *
 * Throws if the input is empty or unparseable.
 */
export function canonicalGitRemote(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) throw new Error('canonicalGitRemote: empty url')

  const sshMatch = /^([^@\s]+)@([^:\s]+):(.+)$/.exec(trimmed)
  if (sshMatch && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const host = sshMatch[2].toLowerCase()
    const path = stripGitSuffix(stripSlashes(sshMatch[3]))
    if (!path) throw new Error(`canonicalGitRemote: empty path in ${rawUrl}`)
    return `${host}/${path}`
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`canonicalGitRemote: cannot parse ${rawUrl}`)
  }
  const host = parsed.hostname.toLowerCase()
  const path = stripGitSuffix(stripSlashes(parsed.pathname))
  if (!host) throw new Error(`canonicalGitRemote: missing host in ${rawUrl}`)
  if (!path) throw new Error(`canonicalGitRemote: empty path in ${rawUrl}`)
  return `${host}/${path}`
}

function stripSlashes(s: string): string {
  return s.replace(/^\/+/, '').replace(/\/+$/, '')
}

function stripGitSuffix(s: string): string {
  return s.endsWith('.git') ? s.slice(0, -4) : s
}
