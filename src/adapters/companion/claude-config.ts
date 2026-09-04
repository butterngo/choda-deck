// TASK-1828 — what is actually configured on this machine: the skills, slash
// commands and global CLAUDE.md that live in ~/.claude, outside every workspace.
//
// The project half of this feature needs nothing here. `.claude/rules`,
// `.claude/skills`, `.mcp.json` and a project CLAUDE.md all sit inside a
// workspace cwd, which workspace-docs already serves as a whole tree. Only the
// GLOBAL half was unreachable, and this module is that half.
//
// ## The sandbox is the whole security surface
//
// vault.ts chose `30-Knowledge` as its root rather than the vault, so 20-Areas
// is unreachable *structurally* rather than by a filter. The same reasoning
// applies here and is stronger: ~/.claude also holds history.jsonl, sessions/,
// projects/ and shell-snapshots/ — every prompt ever typed. So the root cannot
// be ~/.claude.
//
// But it cannot be one directory either: `commands` and `CLAUDE.md` are
// SIBLINGS of `skills`, not children. Hence an ALLOWLIST of roots. Anything not
// named is unreachable because it was never named — the same structural stance,
// expressed as a set instead of a prefix.
//
// ## Both sides get realpath'd, and that is not paranoia
//
// On the machine this was written for, `~/.claude/commands` is a symlink. Two
// obvious implementations are wrong in opposite directions:
//
//   - resolve the request but prefix-check against the UNRESOLVED root: the real
//     path lands elsewhere, the check fails, and the whole commands group
//     silently disappears
//   - do not resolve at all: any symlink planted under an allowed root escapes
//     the sandbox
//
// So each root is resolved, each requested path is resolved, and the comparison
// is resolved-against-resolved. A link's target becomes an allowed root in its
// own right; its siblings do not.
//
// ## A root that does not resolve is normal, not exceptional
//
// That same `commands` symlink is DANGLING — readlink gives a target,
// realpath gives ENOENT. `realpathSync` throws, so a naive resolver takes the
// whole route down over a link nobody has repointed in months. An unresolvable
// root is carried with `real: null`: it lists nothing and serves nothing, and
// the rest of the inventory is unaffected.
//
// ## Installed plugins are not the plugins on disk
//
// ~/.claude/plugins holds 29 SKILL.md files and exactly one INSTALLED plugin;
// the rest are marketplace listings — a catalogue of what could be installed.
// Walking the tree reports 42 skills against a real 15, which would deepen the
// exact confusion this feature exists to remove. installed_plugins.json is the
// only discriminator, and nothing in the directory layout hints that it matters.
//
// Follows workspace-docs.ts and vault.ts: raw-URL matched, token-gated with
// x-choda-bridge-token, read-only, returns false when the request is not ours.

import * as fs from 'fs'
import * as path from 'path'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'

const LIST_ROUTE = '/claude-config'
const FILE_ROUTE_PREFIX = '/claude-config/'

/** How deep a commands tree is walked. Commands nest one level at most today. */
const COMMAND_WALK_DEPTH = 3

export interface ClaudeSkill {
  name: string
  description: string
  scope: 'global' | 'plugin'
  /** Non-null exactly when scope is 'plugin'. */
  pluginId: string | null
  /** Absolute path, for display and copying only — never accepted as input. */
  path: string
}

export interface ClaudeCommand {
  name: string
  path: string
}

export interface ClaudeRule {
  name: string
  path: string
}

export interface ClaudeConfigInventory {
  skills: ClaudeSkill[]
  commands: ClaudeCommand[]
  rules: ClaudeRule[]
}

export type RootKind = 'dir' | 'file'

export interface AllowedRoot {
  /** Addressable id: 'skills' | 'commands' | 'claude-md' | 'plugin:<key>'. */
  id: string
  kind: RootKind
  /** Where the allowlist says it is, before resolution. */
  declared: string
  /** Resolved path, or null when the root is missing or dangling. */
  real: string | null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return false
  return timingSafeEqual(provided, expectedBuf)
}

/** realpath, or null. A missing or dangling path is a normal state here. */
function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/**
 * Frontmatter reader that understands FOLDED scalars.
 *
 * vault.ts already exports a parseFrontmatter, and reusing it was the first
 * plan. It reads flat `key: value` only — and 11 of the 13 skills on this
 * machine write `description: >` with the text on following indented lines, so
 * reuse would have left the majority of the inventory with a blank description
 * while every test on flat fixtures passed.
 *
 * Still not a YAML parser: keys at column 0, values either inline or a folded /
 * literal block. That is the whole of what a SKILL.md header uses.
 */
export function parseSkillFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}

  const lines = text.slice(3, end).split('\n')
  const out: Record<string, string> = {}
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    // Indented lines belong to the value above; a line with no colon is not a key.
    if (/^\s/.test(line) || line.indexOf(':') <= 0) {
      i++
      continue
    }
    const at = line.indexOf(':')
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    i++

    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts: string[] = []
      while (i < lines.length && (/^\s+\S/.test(lines[i]) || lines[i].trim() === '')) {
        const trimmed = lines[i].trim()
        if (trimmed.length > 0) parts.push(trimmed)
        i++
      }
      value = parts.join(' ')
    }

    if (key.length > 0) out[key] = value
  }
  return out
}

/**
 * The skills directory of every INSTALLED plugin. Marketplace listings under
 * plugins/marketplaces are deliberately not consulted — see the header.
 */
function installedPluginSkillRoots(claudeHome: string): { id: string; dir: string }[] {
  const manifest = path.join(claudeHome, 'plugins', 'installed_plugins.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  } catch {
    // No plugins installed, or a manifest this version cannot read. Either way
    // the answer is "no plugin skills", never a failed inventory.
    return []
  }
  const plugins = (parsed as { plugins?: Record<string, unknown> })?.plugins
  if (!plugins || typeof plugins !== 'object') return []

  const out: { id: string; dir: string }[] = []
  for (const [key, entries] of Object.entries(plugins)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const installPath = (entry as { installPath?: unknown })?.installPath
      if (typeof installPath !== 'string' || installPath.length === 0) continue
      out.push({ id: key, dir: path.join(installPath, 'skills') })
    }
  }
  return out
}

/**
 * The allowlist. Resolved per request rather than once at boot: resolution is
 * four realpath calls, and caching it would mean a plugin installed while the
 * app is running stays invisible until the adapter restarts.
 */
export function resolveRoots(claudeHome: string): AllowedRoot[] {
  const declared: { id: string; kind: RootKind; declared: string }[] = [
    { id: 'skills', kind: 'dir', declared: path.join(claudeHome, 'skills') },
    { id: 'commands', kind: 'dir', declared: path.join(claudeHome, 'commands') },
    { id: 'claude-md', kind: 'file', declared: path.join(claudeHome, 'CLAUDE.md') },
    ...installedPluginSkillRoots(claudeHome).map((p) => ({
      id: `plugin:${p.id}`,
      kind: 'dir' as RootKind,
      declared: p.dir
    }))
  ]
  return declared.map((d) => ({ ...d, real: realOrNull(d.declared) }))
}

/** True when a RESOLVED path lies within a resolved root. */
export function isWithinRoots(roots: AllowedRoot[], resolved: string): boolean {
  return roots.some((r) => {
    if (r.real === null) return false
    if (r.kind === 'file') return resolved === r.real
    return resolved === r.real || resolved.startsWith(r.real + path.sep)
  })
}

/** Skill directories under one root: a directory is a skill only if it has SKILL.md. */
function skillsUnder(root: AllowedRoot, scope: 'global' | 'plugin', pluginId: string | null): ClaudeSkill[] {
  if (root.real === null) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root.real, { withFileTypes: true })
  } catch {
    return []
  }

  const out: ClaudeSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const file = path.join(root.real, entry.name, 'SKILL.md')
    // The discriminator: `README.md` and `docs/` sit beside real skills and are
    // not skills. Asking the filesystem is cheaper than maintaining a denylist,
    // and it stays right when a new non-skill directory appears.
    if (!fs.existsSync(file)) continue

    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const fm = parseSkillFrontmatter(text)
    out.push({
      // Fall back to the directory name rather than dropping the row: a skill
      // with unreadable frontmatter still exists and still gets loaded.
      name: fm.name && fm.name.length > 0 ? fm.name : entry.name,
      description: fm.description ?? '',
      scope,
      pluginId,
      path: file
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function commandsUnder(root: AllowedRoot): ClaudeCommand[] {
  if (root.real === null) return []
  const base = root.real
  const out: ClaudeCommand[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > COMMAND_WALK_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const rel = path.relative(base, full).replace(/\\/g, '/')
        out.push({ name: rel.replace(/\.md$/i, ''), path: full })
      }
    }
  }

  walk(base, 0)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The whole global inventory. Never throws on a missing or dangling root. */
export function readInventory(claudeHome: string): ClaudeConfigInventory {
  const roots = resolveRoots(claudeHome)
  const byId = (id: string): AllowedRoot | undefined => roots.find((r) => r.id === id)

  const skills: ClaudeSkill[] = []
  const skillsRoot = byId('skills')
  if (skillsRoot) skills.push(...skillsUnder(skillsRoot, 'global', null))
  for (const root of roots) {
    if (!root.id.startsWith('plugin:')) continue
    skills.push(...skillsUnder(root, 'plugin', root.id.slice('plugin:'.length)))
  }

  const commandsRoot = byId('commands')
  const rulesRoot = byId('claude-md')

  return {
    skills,
    commands: commandsRoot ? commandsUnder(commandsRoot) : [],
    rules: rulesRoot && rulesRoot.real !== null ? [{ name: 'CLAUDE.md', path: rulesRoot.real }] : []
  }
}

/**
 * GET /claude-config                          -> { skills, commands, rules }
 * GET /claude-config/<rootId>/<relative path> -> text/plain
 *
 * Returns false when the request isn't ours, so the caller falls through to the
 * rest of the router (mirrors handleVaultRoute / handleWorkspaceDocsRoute).
 */
export function handleClaudeConfigRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { claudeHome?: string; bridgeToken: string }
): boolean {
  // Match on the RAW url: `new URL()` collapses dot segments before a handler
  // sees them, which would turn a refusal into a silent 404.
  const rawPath = (req.url ?? '/').split('?')[0]
  if (rawPath !== LIST_ROUTE && !rawPath.startsWith(FILE_ROUTE_PREFIX)) return false

  if ((req.method ?? 'GET') !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, opts.bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }
  // Symmetric with vault.ts and artifacts.ts: the request was well-formed, the
  // server just is not configured to answer it.
  if (!opts.claudeHome) {
    sendJson(res, 501, { error: 'claude config serving not configured' })
    return true
  }

  if (rawPath === LIST_ROUTE) {
    sendJson(res, 200, readInventory(opts.claudeHome))
    return true
  }

  const rest = rawPath.slice(FILE_ROUTE_PREFIX.length)
  const slash = rest.indexOf('/')
  let rootId: string
  let rel: string
  try {
    rootId = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash))
    rel = slash < 0 ? '' : decodeURIComponent(rest.slice(slash + 1))
  } catch {
    sendJson(res, 400, { error: 'invalid path' })
    return true
  }

  const roots = resolveRoots(opts.claudeHome)
  const root = roots.find((r) => r.id === rootId)
  // An id nobody publishes is a malformed request, not a refusal — it says
  // nothing about what does or does not exist on disk.
  if (!root) {
    sendJson(res, 400, { error: 'invalid path' })
    return true
  }
  if (root.real === null) {
    sendJson(res, 404, { error: `not found: ${rootId}` })
    return true
  }

  const target = root.kind === 'file' ? root.real : path.resolve(root.real, rel)

  // Resolve the TARGET before judging it. A traversal and a planted symlink are
  // the same defect seen from two angles — both are paths that resolve outside
  // the allowlist — so both get the same answer, and neither gets to disclose
  // whether the thing it reached for exists.
  const resolved = realOrNull(target)
  if (resolved === null) {
    // Distinguish "outside, and also missing" from "inside, and missing":
    // an unresolvable path that could not have been allowed anyway is a refusal.
    const wouldBeInside = isWithinRoots(roots, path.resolve(target))
    sendJson(
      res,
      wouldBeInside ? 404 : 403,
      wouldBeInside ? { error: `not found: ${rel}` } : { error: 'outside the allowed roots' }
    )
    return true
  }
  if (!isWithinRoots(roots, resolved)) {
    sendJson(res, 403, { error: 'outside the allowed roots' })
    return true
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    sendJson(res, 404, { error: `not found: ${rel}` })
    return true
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: `not a file: ${rel}` })
    return true
  }

  const isMd = resolved.toLowerCase().endsWith('.md')
  res.writeHead(200, {
    'content-type': isMd ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8'
  })
  res.end(fs.readFileSync(resolved, 'utf8'))
  return true
}
