// TASK-2048 — read what a project has in the vault, so the companion can say
// where a meeting note went.
//
// A SECOND SANDBOX ROOT, NOT A WIDER ONE. vault.ts resolves its root to
// `<vaultDir>/30-Knowledge` and its header says why: the vault also holds
// 20-Areas (personal preferences, goals) which must not become HTTP-reachable
// as a side effect of wanting to read notes, and the scoping is structural
// rather than a filter. Reaching 10-Projects by widening that root to
// `vaultDir` would hand 20-Areas out with it. So this module resolves its own
// root to `<vaultDir>/10-Projects` and shares nothing with the other but the
// token gate and the GET-only guard in handleVaultRoute.
//
// Read-only. It lists what a project folder holds, and — since TASK-2051 — also
// serves the contents of ONE named file inside a meeting folder.
//
// TASK-2048 originally refused to serve contents at all, on the reasoning that a
// meeting note is client conversation and "where is it" is a different question
// from "what does it say". That was conservatism about a brand-new sandbox root,
// not a constraint anyone imposed, and it left Butter unable to read his own
// note in his own app. TASK-2051 reverses it deliberately. What does NOT change:
// the root is still 10-Projects and nothing above it, and there is still no way
// to write.
//
// The reading route is narrower than the listing one, not wider. The filename is
// an ALLOWLIST of the two files a saved meeting can hold, never a path segment
// the caller chooses — so "which files can be read" is a closed set decided here
// rather than whatever happens to sit in the folder.

import * as fs from 'fs'
import * as path from 'path'
import type { ServerResponse } from 'http'

/** The vault folder that mirrors choda-tasks projects, one directory per id. */
export const PROJECTS_DIR = '10-Projects'

/** Where meetings live inside a project folder (meeting-files.ts writes here). */
export const MEETINGS_SUBDIR = 'meetings'

/** The project-level note the vault convention expects at the folder root. */
export const CONTEXT_FILE = 'context.md'

/** The two files a saved meeting can hold (MEETING_FILE_NAMES in meeting-files.ts). */
export const MEETING_FILES = ['note.md', 'transcript.md'] as const
export type MeetingFileName = (typeof MEETING_FILES)[number]

/**
 * A project id becomes a directory name, so it is checked rather than trusted.
 * The same alphabet meeting ids use, widened only by length — project ids are
 * human-chosen slugs like `business-process-automation`.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/

/** `2026-09-17-chi-kate` → date + slug. A folder that does not match still lists. */
const FOLDER_RE = /^(\d{4}-\d{2}-\d{2})-(.+)$/

/**
 * A meeting folder name becomes a path segment, so it is checked rather than
 * trusted — the same treatment ID_RE gives a project id, widened only by the
 * dot that a dated folder name may carry in its slug. A dot SEGMENT (`.`, `..`)
 * is excluded separately below, because this alphabet alone would admit them.
 */
const FOLDER_SEG_RE = /^[A-Za-z0-9_.-]{1,200}$/

/**
 * TASK-2051 — the ceiling on a file this route will serve, decided with Butter
 * on 2026-09-20 and measured against what is actually on disk: notes run 34-40 KB
 * and the largest transcript is ~300 KB, so this is ~7x the biggest real file.
 *
 * It exists because the response is read whole into the renderer and then parsed
 * as markdown, on the UI thread. A file that is unexpectedly enormous would be
 * held in memory twice and handed to a parser there. Refusing with a size is a
 * legible failure; a frozen window is not.
 *
 * Over the ceiling the file is REFUSED, not truncated: half a note that looks
 * whole is worse than a message saying it is too large, because nothing in the
 * rendered output would reveal what was cut.
 */
export const VAULT_FILE_MAX_BYTES = 2 * 1024 * 1024

export interface VaultMeetingFile {
  name: MeetingFileName
  present: boolean
  /** Null when the file is absent — distinct from a real zero-byte file. */
  bytes: number | null
}

export interface VaultMeeting {
  folder: string
  /** Null when the folder name does not carry a date — the folder still lists. */
  date: string | null
  slug: string | null
  files: VaultMeetingFile[]
}

export interface ProjectVault {
  projectId: string
  /** False when nothing has ever been saved for this project. */
  exists: boolean
  /** Always reported, existing or not: this is the path that WOULD be created. */
  relativePath: string
  contextFile: boolean
  meetings: VaultMeeting[]
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** True only for a directory that exists — a file or a missing path is false. */
function statIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Is `target` the same as `root`, or inside it? Compares RESOLVED paths and
 * requires a real step below the root, so a sibling sharing a string prefix is
 * not mistaken for a child.
 */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), target)
  if (rel === '') return true
  if (rel.startsWith('..')) return false
  return !path.isAbsolute(rel)
}

function sizeOf(file: string): number | null {
  try {
    const st = fs.statSync(file)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

/** Newest first, by folder name — the same order the dates sort in. */
function readMeetings(projectDir: string): VaultMeeting[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(projectDir, MEETINGS_SUBDIR), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(projectDir, MEETINGS_SUBDIR, e.name)
      const m = FOLDER_RE.exec(e.name)
      return {
        folder: e.name,
        // A folder someone made by hand must not vanish from the listing just
        // because its name does not match the convention. Its date is unknown,
        // which is a different claim from "it is not a meeting".
        date: m ? m[1] : null,
        slug: m ? m[2] : null,
        files: MEETING_FILES.map((name) => {
          const bytes = sizeOf(path.join(dir, name))
          return { name, present: bytes !== null, bytes }
        })
      }
    })
    .sort((a, b) => b.folder.localeCompare(a.folder))
}

/**
 * What one project has in the vault. `exists: false` is a real answer, not an
 * error: five of the twelve registered projects have never had anything saved,
 * and that must read differently from a folder holding zero meetings.
 */
export function readProjectVault(projectsRoot: string, projectId: string): ProjectVault {
  const dir = path.join(projectsRoot, projectId)
  const relativePath = ['vault', PROJECTS_DIR, projectId].join('/')

  const exists = statIsDirectory(dir)
  if (!exists) {
    return { projectId, exists: false, relativePath, contextFile: false, meetings: [] }
  }

  return {
    projectId,
    exists: true,
    relativePath,
    contextFile: sizeOf(path.join(dir, CONTEXT_FILE)) !== null,
    meetings: readMeetings(dir)
  }
}

/** Is `name` one of the two files a saved meeting can hold? */
function isMeetingFile(name: string): name is MeetingFileName {
  return (MEETING_FILES as readonly string[]).includes(name)
}

/**
 * GET /vault/projects/:id/meetings/:folder/:file — the contents of one saved file.
 *
 * Narrower than the listing route by design. `file` is checked against the
 * MEETING_FILES allowlist rather than being joined as a caller-chosen segment,
 * so what can be read is a closed set decided in this module. `folder` is
 * checked against FOLDER_SEG_RE and against being a dot segment, and the
 * resolved path is confirmed to still sit inside the meetings directory before
 * anything is read — belt and braces, because a recursive read of the wrong
 * place is the failure that matters here.
 *
 * Absent project, absent folder and absent file are three DIFFERENT answers.
 * Collapsing them would leave the UI unable to say which thing is missing.
 */
function serveMeetingFile(
  res: ServerResponse,
  projectsRoot: string,
  projectId: string,
  rawFolder: string,
  rawFile: string
): boolean {
  let folder: string
  let file: string
  try {
    folder = decodeURIComponent(rawFolder)
    file = decodeURIComponent(rawFile)
  } catch {
    sendJson(res, 400, { error: 'malformed path' })
    return true
  }

  // Checked on the DECODED values: `%2e%2e` is `..` by the time it reaches a
  // path join, so validating the raw form would be validating the wrong string.
  if (!ID_RE.test(projectId)) {
    sendJson(res, 400, { error: 'invalid project id' })
    return true
  }
  if (!FOLDER_SEG_RE.test(folder) || folder === '.' || folder === '..') {
    sendJson(res, 400, { error: 'invalid meeting folder' })
    return true
  }
  if (!isMeetingFile(file)) {
    // Not "not found" — the name is refused on principle, and saying so keeps
    // this route from being usable to probe what else is in the folder.
    sendJson(res, 400, { error: 'file not readable through this route' })
    return true
  }

  const projectDir = path.join(projectsRoot, projectId)
  if (!statIsDirectory(projectDir)) {
    sendJson(res, 404, { error: 'project has nothing in the vault' })
    return true
  }
  const meetingsDir = path.join(projectDir, MEETINGS_SUBDIR)
  const dir = path.join(meetingsDir, folder)
  // The guards above should make this unreachable. It stays because the cost of
  // being wrong is reading a file outside the vault, and a resolved-path check
  // does not depend on any regex being exhaustive.
  if (!isInside(meetingsDir, path.resolve(dir))) {
    sendJson(res, 400, { error: 'invalid meeting folder' })
    return true
  }
  if (!statIsDirectory(dir)) {
    sendJson(res, 404, { error: 'meeting not found' })
    return true
  }

  const target = path.join(dir, file)
  const bytes = sizeOf(target)
  if (bytes === null) {
    sendJson(res, 404, { error: 'file not saved' })
    return true
  }
  if (bytes > VAULT_FILE_MAX_BYTES) {
    sendJson(res, 413, {
      error: 'file too large to display',
      bytes,
      maxBytes: VAULT_FILE_MAX_BYTES
    })
    return true
  }

  let markdown: string
  try {
    markdown = fs.readFileSync(target, 'utf8')
  } catch {
    sendJson(res, 404, { error: 'file not saved' })
    return true
  }
  sendJson(res, 200, { projectId, folder, file, bytes, markdown })
  return true
}

/**
 * GET /vault/projects/:id — called from handleVaultRoute AFTER its token check
 * and its GET-only guard, so this assumes an authenticated read.
 *
 * `projectsRoot` is resolved by the caller to `<vaultDir>/10-Projects`. The id
 * is checked against ID_RE before it is joined: a separator, a dot segment or a
 * drive letter is refused here, before any filesystem call, which is what keeps
 * `..%2F..%2F20-Areas` from resolving anywhere at all.
 */
export function handleProjectVault(res: ServerResponse, projectsRoot: string, rest: string): boolean {
  // `<id>` lists the project; `<id>/meetings/<folder>/<file>` reads one file.
  // Split before decoding so an encoded separator cannot invent a segment.
  const parts = rest.split('/')
  if (parts.length === 4 && parts[1] === MEETINGS_SUBDIR) {
    let pid: string
    try {
      pid = decodeURIComponent(parts[0] ?? '')
    } catch {
      sendJson(res, 400, { error: 'malformed project id' })
      return true
    }
    return serveMeetingFile(res, projectsRoot, pid, parts[2] ?? '', parts[3] ?? '')
  }
  if (parts.length !== 1) {
    sendJson(res, 404, { error: 'not found' })
    return true
  }

  let id: string
  try {
    id = decodeURIComponent(parts[0] ?? '')
  } catch {
    sendJson(res, 400, { error: 'malformed project id' })
    return true
  }
  // Checked on the DECODED value: `%2e%2e` is `..` by the time it reaches a path
  // join, so validating the raw form would be validating the wrong string.
  if (!ID_RE.test(id)) {
    sendJson(res, 400, { error: 'invalid project id' })
    return true
  }

  sendJson(res, 200, readProjectVault(projectsRoot, id))
  return true
}
