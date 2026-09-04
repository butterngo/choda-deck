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
import { createHash, timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'

const LIST_ROUTE = '/claude-config'
const FILE_ROUTE_PREFIX = '/claude-config/'

/** How deep a commands tree is walked. Commands nest one level at most today. */
const COMMAND_WALK_DEPTH = 3

/**
 * How to ASK for this file, as opposed to where it happens to live.
 *
 * TASK-1831. The file route deliberately refuses absolute paths — an absolute
 * path in a URL is a traversal surface that then has to be defended. That left
 * a client holding a display path with no way to turn it into a request, and
 * the consequence was worse than inconvenient: the route shipped in TASK-1828
 * with five criteria and twenty-one tests, and nothing ever called it.
 *
 * Reconstructing rootId and rel from the display path is the obvious repair and
 * the wrong one — it makes every client re-derive what this module already
 * knows, and it breaks the moment a skill nests deeper than one directory. So
 * the answer travels with the row.
 */
export interface ClaudeRef {
  /** 'skills' | 'commands' | 'claude-md' | 'plugin:<key>' */
  rootId: string
  /** Forward-slashed, relative to the resolved root. Empty for a file root. */
  rel: string
}

export interface ClaudeSkill {
  name: string
  description: string
  scope: 'global' | 'plugin'
  /** Non-null exactly when scope is 'plugin'. */
  pluginId: string | null
  /** Absolute path, for display and copying only — never accepted as input. */
  path: string
  ref: ClaudeRef
}

export interface ClaudeCommand {
  name: string
  path: string
  ref: ClaudeRef
}

export interface ClaudeRule {
  name: string
  path: string
  ref: ClaudeRef
}

export interface ClaudeConfigInventory {
  skills: ClaudeSkill[]
  commands: ClaudeCommand[]
  rules: ClaudeRule[]
  mcpServers: McpServer[]
  mcpScope: McpScope
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

/** Forward-slashed path of `file` relative to a root, for the file route. */
function refFor(root: AllowedRoot, file: string): ClaudeRef {
  if (root.kind === 'file' || root.real === null) return { rootId: root.id, rel: '' }
  return { rootId: root.id, rel: path.relative(root.real, file).split(path.sep).join('/') }
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
      path: file,
      ref: refFor(root, file)
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
        out.push({ name: rel.replace(/\.md$/i, ''), path: full, ref: refFor(root, full) })
      }
    }
  }

  walk(base, 0)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The whole global inventory. Never throws on a missing or dangling root. */
export function readInventory(claudeHome: string, workspaceCwd?: string): ClaudeConfigInventory {
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
    rules:
      rulesRoot && rulesRoot.real !== null
        ? [{ name: 'CLAUDE.md', path: rulesRoot.real, ref: refFor(rulesRoot, rulesRoot.real) }]
        : [],
    mcpServers: readMcpServers(claudeHome, workspaceCwd),
    mcpScope: MCP_SCOPE
  }
}

export interface McpServer {
  name: string
  /** Where it is DECLARED: the user's ~/.claude.json, or a repo's .mcp.json. */
  origin: 'global' | 'project'
  transport: string | null
  /**
   * Measured, not assumed (TASK-1829, 2026-09-04). A scratch project with two
   * probes in .mcp.json was run through `claude mcp list` two ways:
   *
   *   no project entry          -> both probes "Pending approval"
   *   one enabled, one disabled -> the enabled one connects; the disabled one
   *                                is ABSENT from the output entirely
   *
   * So there are three states, not two. A boolean would render a pending server
   * as on or off and both are wrong. And because a disabled server vanishes from
   * what is running, "disabled" is knowable only from config — which is exactly
   * why an INVENTORY still lists it rather than agreeing with the runtime.
   */
  status: 'active' | 'disabled' | 'pending'
  /** Absolute path of the file it was read from. Display and copy only. */
  source: string
  /** Parse failure. When set, the other fields carry no meaning. */
  error: string | null
}

export interface McpScope {
  localOnly: true
  note: string
}

/**
 * What this inventory cannot see, said out loud.
 *
 * `claude mcp list` reports 16 servers on the machine this was built for;
 * ~/.claude.json declares 6. The other ten are claude.ai connectors configured
 * ACCOUNT-side — locally there is only mcp-needs-auth-cache.json, which holds
 * names and ids but no URLs and no complete list. They cannot be enumerated
 * from disk at all.
 *
 * That is the same class of error as the 42-skills count, inverted: 42 lies by
 * including what is not there, 6-of-16 lies by omitting what is. The count is
 * only honest if the boundary travels with it, so the boundary is a field.
 */
export const MCP_SCOPE: McpScope = {
  localOnly: true,
  note: 'claude.ai connectors are configured account-side and cannot be listed from disk'
}

/** Windows path comparison is case-insensitive; POSIX is not. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return norm(a) === norm(b)
}

/**
 * The enable/disable lists for one workspace, unioned across EVERY matching
 * project key.
 *
 * .claude.json really carries both `C:/dev/choda-deck` and `c:/dev/choda-deck`
 * — two entries differing only in drive-letter case, each with its own
 * settings. A string-keyed lookup finds one and silently ignores the other, so
 * the keys are compared as resolved paths and the matches are merged.
 */
function approvalLists(
  claudeJson: unknown,
  cwd: string
): { enabled: Set<string>; disabled: Set<string> } {
  const enabled = new Set<string>()
  const disabled = new Set<string>()
  const projects = (claudeJson as { projects?: Record<string, unknown> })?.projects
  if (!projects || typeof projects !== 'object') return { enabled, disabled }

  for (const [key, entry] of Object.entries(projects)) {
    if (!samePath(key, cwd)) continue
    const e = entry as { enabledMcpjsonServers?: unknown; disabledMcpjsonServers?: unknown }
    if (Array.isArray(e?.enabledMcpjsonServers)) {
      for (const n of e.enabledMcpjsonServers) if (typeof n === 'string') enabled.add(n)
    }
    if (Array.isArray(e?.disabledMcpjsonServers)) {
      for (const n of e.disabledMcpjsonServers) if (typeof n === 'string') disabled.add(n)
    }
  }
  return { enabled, disabled }
}

function transportOf(entry: unknown): string | null {
  const t = (entry as { type?: unknown })?.type
  return typeof t === 'string' && t.length > 0 ? t : null
}

/**
 * MCP servers as a PROJECTION of .claude.json and a repo's .mcp.json.
 *
 * .claude.json is never served as a file and never gets a root in the
 * allowlist: it is ~123 KB of which MCP is a minority, sharing the document
 * with userID, per-project allowedTools and trust-dialog state.
 */
export function readMcpServers(claudeHome: string, workspaceCwd?: string): McpServer[] {
  const claudeJsonPath = path.join(path.dirname(claudeHome), '.claude.json')
  let claudeJson: unknown = {}
  try {
    claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'))
  } catch {
    claudeJson = {}
  }

  const out: McpServer[] = []

  const globals = (claudeJson as { mcpServers?: Record<string, unknown> })?.mcpServers
  if (globals && typeof globals === 'object') {
    for (const [name, entry] of Object.entries(globals)) {
      // Approval does not apply to a globally declared server — it is simply on.
      out.push({
        name,
        origin: 'global',
        transport: transportOf(entry),
        status: 'active',
        source: claudeJsonPath,
        error: null
      })
    }
  }

  if (!workspaceCwd) return out

  const mcpJsonPath = path.join(workspaceCwd, '.mcp.json')
  if (!fs.existsSync(mcpJsonPath)) return out

  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'))
  } catch (err) {
    // One unreadable row naming the reason, rather than a failed request: a repo
    // with a broken .mcp.json still has skills and commands worth showing, and a
    // 500 would hide all of them.
    out.push({
      name: '.mcp.json',
      origin: 'project',
      transport: null,
      status: 'pending',
      source: mcpJsonPath,
      error: err instanceof Error ? err.message : String(err)
    })
    return out
  }

  const { enabled, disabled } = approvalLists(claudeJson, workspaceCwd)
  const declared = (parsed as { mcpServers?: Record<string, unknown> })?.mcpServers
  if (declared && typeof declared === 'object') {
    for (const [name, entry] of Object.entries(declared)) {
      out.push({
        name,
        origin: 'project',
        transport: transportOf(entry),
        // A disabled server is LISTED, not omitted. Omitting it would make the
        // inventory agree with `claude mcp list`, which is a different question:
        // what is running, rather than what is configured.
        status: disabled.has(name) ? 'disabled' : enabled.has(name) ? 'active' : 'pending',
        source: mcpJsonPath,
        error: null
      })
    }
  }

  return out
}

/**
 * TASK-1841 — the write cap. The largest config file on this machine is
 * template-registry.json at 117 KB; 2 MB leaves room without letting a runaway
 * client stream forever into memory.
 */
const MAX_WRITE_BYTES = 2 * 1024 * 1024

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * The request body as RAW BYTES, or null once the cap is exceeded.
 *
 * Deliberately not `readBody` from workflow.ts, which decodes to utf8 and
 * JSON.parses. A config file's bytes are the payload here: decoding and
 * re-encoding is exactly the round trip that loses a BOM and rewrites line
 * endings, and this route's whole promise is that it does not transform what it
 * is given.
 *
 * The cap is enforced while reading, not after — a 500 MB body must not be
 * buffered first and rejected second.
 */
function readRawBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let over = false
    req.on('data', (c: Buffer) => {
      if (over) return
      total += c.length
      if (total > MAX_WRITE_BYTES) {
        over = true
        chunks.length = 0
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Write via a temp file in the SAME directory, then rename.
 *
 * bridge-token.ts writes in place, and the stakes are what differ: truncating
 * settings.local.json halfway leaves an unusable config, and this feature keeps
 * no backup — the 409 is the only thing between two writers and a lost edit, and
 * it cannot help if the file is already half-written. Rename within a directory
 * is atomic on both platforms; across directories it is not, which is why the
 * temp file is a sibling rather than in os.tmpdir().
 */
function writeAtomic(target: string, bytes: Buffer): void {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`)
  try {
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, target)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // The temp file may never have been created; failing to remove it must
      // not mask the write error being thrown.
    }
    throw err
  }
}

/**
 * GET /claude-config[?workspaceId=<id>]       -> { skills, commands, rules,
 *                                                 mcpServers, mcpScope }
 * GET /claude-config/<rootId>/<relative path> -> text/plain
 *
 * Returns false when the request isn't ours, so the caller falls through to the
 * rest of the router (mirrors handleVaultRoute / handleWorkspaceDocsRoute).
 */
export async function handleClaudeConfigRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { claudeHome?: string; bridgeToken: string; svc: WorkspaceOperations }
): Promise<boolean> {
  // Match on the RAW url: `new URL()` collapses dot segments before a handler
  // sees them, which would turn a refusal into a silent 404.
  const rawPath = (req.url ?? '/').split('?')[0]
  if (rawPath !== LIST_ROUTE && !rawPath.startsWith(FILE_ROUTE_PREFIX)) return false

  // GET everywhere; PUT only on the FILE route. The inventory is a projection
  // and has nothing to write back to, so a PUT there is a client bug, not a
  // feature nobody built yet.
  const method = req.method ?? 'GET'
  if (method !== 'GET' && !(method === 'PUT' && rawPath.startsWith(FILE_ROUTE_PREFIX))) {
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
    // workspaceId is OPTIONAL: without one the answer is the global half, which
    // is a real and complete answer to "what is configured on this machine".
    // Requiring it would make the route unusable from anywhere that is not
    // already inside a workspace.
    const workspaceId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('workspaceId')
    let cwd: string | undefined
    if (workspaceId) {
      const workspace = await opts.svc.getWorkspace(workspaceId)
      if (!workspace) {
        sendJson(res, 404, { error: `unknown workspace: ${workspaceId}` })
        return true
      }
      cwd = workspace.cwd
    }
    sendJson(res, 200, readInventory(opts.claudeHome, cwd))
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

  const current = fs.readFileSync(resolved)

  if (method === 'PUT') {
    // The precondition is REQUIRED, not optional. A save with nothing to compare
    // against is a save that can silently overwrite an edit made two seconds ago
    // — and since this feature keeps no backup, that edit is simply gone.
    const ifMatch = req.headers['if-match']
    if (typeof ifMatch !== 'string' || ifMatch.length === 0) {
      sendJson(res, 400, { error: 'if-match required' })
      return true
    }

    const body = await readRawBody(req)
    if (body === null) {
      sendJson(res, 413, { error: 'too large' })
      return true
    }

    // Compared against the bytes on disk RIGHT NOW, read above — not against a
    // value cached when the route was entered.
    const currentHash = sha256(current)
    if (ifMatch.replace(/^"|"$/g, '') !== currentHash) {
      sendJson(res, 409, { error: 'file changed on disk', sha256: currentHash })
      return true
    }

    // Written verbatim. The server does not decode, re-encode, normalise line
    // endings or strip a BOM — every one of those would change bytes the human
    // did not touch, and a diff would show the whole file as modified with the
    // real edit buried inside it.
    writeAtomic(resolved, body)
    sendJson(res, 200, { sha256: sha256(body), bytes: body.length })
    return true
  }

  const isMd = resolved.toLowerCase().endsWith('.md')
  res.writeHead(200, {
    'content-type': isMd ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
    // The client needs something to send back as if-match. A content hash rather
    // than an mtime: mtimes have coarse resolution, move backwards across clock
    // changes, and are altered by tools that changed no bytes.
    etag: sha256(current)
  })
  res.end(current)
  return true
}
