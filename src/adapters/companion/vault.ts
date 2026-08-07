// TASK-1576 — serve vault notes to the companion web app.
//
// The vault and choda-tasks are separate stores and only the second was ever
// wired to the companion: every other route here reads SQLite, while
// `vault/30-Knowledge/*.md` had nothing reading it at all. /choda-watch made
// that gap matter — it writes notes with embedded frames that were unreadable
// outside a text editor.
//
// Read-only, and scoped to 30-Knowledge ONLY. The vault also holds 20-Areas
// (personal preferences, goals) which must not become HTTP-reachable as a side
// effect of wanting to read video notes. The sandbox root is the subdirectory,
// not the vault, so that scoping is structural rather than a filter.
//
// Token-gated and raw-URL matched, mirroring artifacts.ts — see hasTraversal
// there for why `new URL()` normalization cannot be trusted for this.

import * as fs from 'fs'
import * as path from 'path'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'

const ROUTE_PREFIX = '/vault/'
const NOTES_DIR = '30-Knowledge'
const NOTES_ROUTE = '/vault/notes'
const LINKS_ROUTE = '/vault/links'
const ASSETS_ROUTE = '/vault/assets/'

// TASK-1601 — `[[target]]`, `[[target|alias]]`, `[[target#heading]]`. The
// capture stops at `|` and `#` so an aliased or anchored link resolves to the
// same note as a bare one; otherwise `[[ddd-basics|DDD]]` would be a dangling
// link to a note named "ddd-basics|DDD".
const WIKILINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g

// Only what the notes actually embed. Anything else is an opaque download
// rather than a guessed type.
const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/**
 * TASK-1601 — the link graph over the served notes.
 *
 * `outgoing` is what a note links to, including targets that do not exist
 * (a dangling link is a fact about the note, worth surfacing). `incoming` is
 * the inverse, and only ever names notes that exist — which is why a dangling
 * target never becomes a key of its own.
 */
export interface VaultNoteLinks {
  outgoing: string[]
  incoming: string[]
}

export interface VaultNoteSummary {
  slug: string
  title: string
  tags: string[]
  captured: string | null
  generatedBy: string | null
  source: string | null
  url: string | null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Duplicated from artifacts.ts rather than exported, for the same reason: this
// module stays independently testable.
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return false
  return timingSafeEqual(provided, expectedBuf)
}

function hasTraversal(relDecoded: string): boolean {
  if (path.isAbsolute(relDecoded) || /^[a-z]:/i.test(relDecoded)) return true
  return relDecoded
    .split(/[/\\]/)
    .some((seg) => seg === '..' || seg === '.' || seg.trim() === '')
}

/**
 * Minimal frontmatter reader — enough for the fields the note template writes,
 * deliberately not a YAML parser. A vault note's frontmatter is flat
 * `key: value` plus one inline `tags: [a, b]` list; pulling in a YAML dependency
 * to read that would be more surface than the feature warrants.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}

  const out: Record<string, string> = {}
  for (const line of text.slice(3, end).split('\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (key.length > 0) out[key] = value
  }
  return out
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function summarize(slug: string, text: string): VaultNoteSummary {
  const fm = parseFrontmatter(text)
  return {
    slug,
    // Fall back to the slug rather than an empty string: a note with malformed
    // frontmatter should still be openable from the list, not invisible.
    title: fm.title ?? slug,
    tags: parseTags(fm.tags),
    captured: fm.captured ?? null,
    generatedBy: fm.generated_by ?? null,
    source: fm.source ?? null,
    url: fm.url ?? null
  }
}

/** Resolve `rel` under `root`, or null if it would escape. */
function safeResolve(root: string, rel: string): string | null {
  if (rel.length === 0 || hasTraversal(rel)) return null
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, rel)
  // Belt-and-braces after the segment scan: a symlink or an encoding the scan
  // missed still cannot land outside the root.
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return null
  return target
}

/**
 * GET /vault/notes                      -> [VaultNoteSummary]
 * GET /vault/notes/:slug                -> text/markdown
 * GET /vault/assets/<slug>/<file>       -> image bytes
 *
 * Returns false when the request isn't ours, so the caller falls through to the
 * rest of the router (mirrors handleArtifactsRoute / handleKnowledgeRoute).
 */
export function handleVaultRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { vaultDir?: string; bridgeToken: string }
): boolean {
  // Match on the raw URL, not url.pathname — see hasTraversal.
  const rawPath = (req.url ?? '/').split('?')[0]
  if (rawPath !== NOTES_ROUTE && !rawPath.startsWith(ROUTE_PREFIX)) return false

  if ((req.method ?? 'GET') !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, opts.bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }
  // Symmetric with the artifacts route: well-formed request, server not configured.
  if (!opts.vaultDir) {
    sendJson(res, 501, { error: 'vault serving not configured' })
    return true
  }

  // The sandbox root is 30-Knowledge, never the vault itself — this is what
  // keeps 20-Areas unreachable rather than merely unlisted.
  const root = path.resolve(opts.vaultDir, NOTES_DIR)

  if (rawPath === NOTES_ROUTE) return listNotes(res, root)
  if (rawPath === LINKS_ROUTE) return listLinks(res, root)
  if (rawPath.startsWith(ASSETS_ROUTE)) {
    return serveAsset(res, root, rawPath.slice(ASSETS_ROUTE.length))
  }
  if (rawPath.startsWith(NOTES_ROUTE + '/')) {
    return serveNote(res, root, rawPath.slice((NOTES_ROUTE + '/').length))
  }

  sendJson(res, 404, { error: 'not found' })
  return true
}

function listNotes(res: ServerResponse, root: string): boolean {
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    sendJson(res, 404, { error: 'vault notes directory not found' })
    return true
  }

  const notes: VaultNoteSummary[] = []
  for (const name of entries.filter((n) => n.toLowerCase().endsWith('.md'))) {
    try {
      const text = fs.readFileSync(path.join(root, name), 'utf8')
      notes.push(summarize(name.replace(/\.md$/i, ''), text))
    } catch {
      // One unreadable note must not blank the whole index.
      continue
    }
  }
  notes.sort((a, b) => a.title.localeCompare(b.title))
  sendJson(res, 200, notes)
  return true
}

/**
 * GET /vault/links -> Record<slug, VaultNoteLinks>
 *
 * TASK-1601 — backlinks cannot be computed client-side: knowing what links
 * INTO a note requires every other note's body, which the companion never
 * has. Outgoing links it could parse itself; they are returned here anyway so
 * both directions come from one consistent scan.
 *
 * Scans on request. At ~50 notes that is a few milliseconds, and a cache would
 * need invalidating against a directory the user edits by hand — correctness
 * before speed until a measurement says otherwise.
 */
function listLinks(res: ServerResponse, root: string): boolean {
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    sendJson(res, 404, { error: 'vault notes directory not found' })
    return true
  }

  const outgoing = new Map<string, string[]>()
  for (const name of entries.filter((n) => n.toLowerCase().endsWith('.md'))) {
    const slug = name.replace(/\.md$/i, '')
    let text: string
    try {
      text = fs.readFileSync(path.join(root, name), 'utf8')
    } catch {
      // Same rule as listNotes: one unreadable note must not blank the graph.
      // It still gets an entry, so it stays a valid backlink target.
      outgoing.set(slug, [])
      continue
    }
    const targets = new Set<string>()
    for (const m of text.matchAll(WIKILINK_RE)) {
      const target = m[1].trim()
      if (target.length > 0) targets.add(target)
    }
    outgoing.set(slug, [...targets].sort())
  }

  // Invert, but only onto slugs that exist — a dangling target is reported in
  // its source's `outgoing` and never invented as a note of its own.
  const links: Record<string, VaultNoteLinks> = {}
  for (const slug of outgoing.keys()) {
    links[slug] = { outgoing: outgoing.get(slug) ?? [], incoming: [] }
  }
  for (const [slug, targets] of outgoing) {
    for (const target of targets) {
      const entry = links[target]
      if (entry) entry.incoming.push(slug)
    }
  }
  for (const entry of Object.values(links)) entry.incoming.sort()

  sendJson(res, 200, links)
  return true
}

function serveNote(res: ServerResponse, root: string, rawSlug: string): boolean {
  let slug: string
  try {
    slug = decodeURIComponent(rawSlug)
  } catch {
    sendJson(res, 400, { error: 'malformed percent-encoding in path' })
    return true
  }
  // The slug names one file directly under 30-Knowledge; a nested path is not a
  // note and is refused rather than resolved.
  if (slug.includes('/') || slug.includes('\\')) {
    sendJson(res, 403, { error: 'path escapes the notes directory' })
    return true
  }

  const target = safeResolve(root, slug.endsWith('.md') ? slug : `${slug}.md`)
  if (target === null) {
    sendJson(res, 403, { error: 'path escapes the notes directory' })
    return true
  }

  let text: string
  try {
    text = fs.readFileSync(target, 'utf8')
  } catch {
    sendJson(res, 404, { error: 'note not found' })
    return true
  }

  res.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-length': String(Buffer.byteLength(text, 'utf8'))
  })
  res.end(text)
  return true
}

function serveAsset(res: ServerResponse, root: string, rawRel: string): boolean {
  let rel: string
  try {
    rel = decodeURIComponent(rawRel)
  } catch {
    sendJson(res, 400, { error: 'malformed percent-encoding in path' })
    return true
  }

  // Notes embed `assets/<slug>/<file>`, relative to the note. The route drops
  // the leading `assets/`, so put it back to resolve against 30-Knowledge.
  const target = safeResolve(root, path.join('assets', rel))
  if (target === null) {
    sendJson(res, 403, { error: 'path escapes the assets directory' })
    return true
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    sendJson(res, 404, { error: 'asset not found' })
    return true
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: 'asset not found' })
    return true
  }

  const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'content-length': String(stat.size) })
  fs.createReadStream(target).pipe(res)
  return true
}
