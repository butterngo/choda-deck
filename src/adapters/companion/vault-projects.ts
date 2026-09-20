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
// Read-only and listing-only. It reports which files exist and how large they
// are; it never returns their contents. A meeting note is client conversation,
// and "where is it" is a different question from "what does it say".

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

  let exists = false
  try {
    exists = fs.statSync(dir).isDirectory()
  } catch {
    exists = false
  }
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

/**
 * GET /vault/projects/:id — called from handleVaultRoute AFTER its token check
 * and its GET-only guard, so this assumes an authenticated read.
 *
 * `projectsRoot` is resolved by the caller to `<vaultDir>/10-Projects`. The id
 * is checked against ID_RE before it is joined: a separator, a dot segment or a
 * drive letter is refused here, before any filesystem call, which is what keeps
 * `..%2F..%2F20-Areas` from resolving anywhere at all.
 */
export function handleProjectVault(res: ServerResponse, projectsRoot: string, rawId: string): boolean {
  let id: string
  try {
    id = decodeURIComponent(rawId)
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
