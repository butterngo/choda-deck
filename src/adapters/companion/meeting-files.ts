// TASK-1994 — save a meeting's transcript and note as markdown files.
//
// Butter's decision (2026-09-17): every save goes to the vault, and a copy can
// ALSO go into a registered workspace's repo, under docs/meetings/. That copy is
// client content in a git working tree, so it is opt-in per meeting, and unless
// asked otherwise the route adds `docs/meetings/` to that repo's .gitignore (the
// same rule that keeps sensitive_information/ out of every repo here).
//
// This is the first route that writes into the vault and into someone else's
// repository, so the surface is kept deliberately small:
//
//   * No client-supplied path is ever joined onto a root. The vault folder comes
//     from a validated project slug; the repo folder comes from the cwd of a
//     workspace looked up by id in the registry. A body cannot name a directory.
//   * Create-only. If ANY target already exists, nothing is written, and the
//     check runs before the first write. A half-saved meeting (transcript in the
//     vault, note refused) is worse than a clean 409.
//   * An unknown workspace fails the whole request, the vault copy included:
//     "saved to the vault, silently not to the repo" would read as success.

import * as fs from 'fs'
import * as path from 'path'
import { Buffer } from 'buffer'
import type { IncomingMessage, ServerResponse } from 'http'
import { readRawBody, writeAtomic } from './atomic-file'

export const MEETING_FILE_NAMES = ['transcript.md', 'note.md'] as const
export type MeetingFileName = (typeof MEETING_FILE_NAMES)[number]

export const REPO_MEETINGS_DIR = path.join('docs', 'meetings')
export const GITIGNORE_LINE = 'docs/meetings/'

const SLUG_RE = /^[a-z0-9-]{1,80}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface MeetingFilesRequest {
  projectId: string | null
  workspaceId: string | null
  date: string
  slug: string
  files: Array<{ name: MeetingFileName; markdown: string }>
  alsoRepo: boolean
  keepOutOfGit: boolean
}

export interface RegisteredWorkspace {
  id: string
  cwd: string
}

export interface MeetingFilesOptions {
  vaultDir?: string
  /** Look a workspace up by id in the registry. Null when not registered. */
  findWorkspace: (id: string) => Promise<RegisteredWorkspace | null>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** The validated request, or the 400 message explaining why it is not one. */
export function parseMeetingFilesRequest(raw: unknown): MeetingFilesRequest | string {
  if (typeof raw !== 'object' || raw === null) return 'body must be a JSON object'
  const b = raw as Record<string, unknown>

  const projectId = b.projectId ?? null
  if (projectId !== null && (typeof projectId !== 'string' || !SLUG_RE.test(projectId))) {
    return 'projectId must match [a-z0-9-]'
  }
  const workspaceId = b.workspaceId ?? null
  if (workspaceId !== null && typeof workspaceId !== 'string') return 'workspaceId must be a string'
  if (typeof b.slug !== 'string' || !SLUG_RE.test(b.slug)) return 'slug must match [a-z0-9-]'
  if (typeof b.date !== 'string' || !DATE_RE.test(b.date)) return 'date must be YYYY-MM-DD'

  if (!Array.isArray(b.files) || b.files.length === 0) return 'files must be a non-empty array'
  const files: MeetingFilesRequest['files'] = []
  const seen = new Set<string>()
  for (const f of b.files as Array<Record<string, unknown>>) {
    if (!MEETING_FILE_NAMES.includes(f?.name as MeetingFileName)) {
      return `file name must be one of ${MEETING_FILE_NAMES.join(', ')}`
    }
    if (typeof f.markdown !== 'string' || f.markdown.length === 0) return `${String(f.name)} is empty`
    if (seen.has(f.name as string)) return `${String(f.name)} is listed twice`
    seen.add(f.name as string)
    files.push({ name: f.name as MeetingFileName, markdown: f.markdown })
  }

  const alsoRepo = b.alsoRepo === true
  if (alsoRepo && workspaceId === null) return 'alsoRepo needs a workspaceId'

  return {
    projectId,
    workspaceId,
    date: b.date,
    slug: b.slug,
    files,
    alsoRepo,
    // Default ON: forgetting the field must not put client content into git.
    keepOutOfGit: b.keepOutOfGit !== false
  }
}

/** Append the ignore line once. Returns true when the file changed. */
export function ensureGitignored(repoRoot: string): boolean {
  const file = path.join(repoRoot, '.gitignore')
  let current = ''
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch {
    // no .gitignore yet — it will be created
  }
  const lines = current.split(/\r?\n/).map((l) => l.trim())
  if (lines.includes(GITIGNORE_LINE) || lines.includes(`/${GITIGNORE_LINE}`)) return false
  // Keep the file's own line ending, and never glue onto a last line that lacks one.
  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const sep = current.length > 0 && !current.endsWith('\n') ? eol : ''
  fs.writeFileSync(file, `${current}${sep}${GITIGNORE_LINE}${eol}`, 'utf8')
  return true
}

/**
 * PUT /meetings/:id/files — called from handleMeetingsRoute after the token check.
 */
export async function handleMeetingFiles(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MeetingFilesOptions
): Promise<void> {
  const raw = await readRawBody(req)
  if (raw === null) {
    sendJson(res, 413, { error: 'too large' })
    return
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.from(raw).toString('utf8'))
  } catch {
    sendJson(res, 400, { error: 'body is not valid JSON' })
    return
  }
  const request = parseMeetingFilesRequest(body)
  if (typeof request === 'string') {
    sendJson(res, 400, { error: request })
    return
  }

  if (!opts.vaultDir) {
    sendJson(res, 501, { error: 'vault not configured' })
    return
  }

  // Every target is resolved BEFORE anything touches the disk.
  const folder = `${request.date}-${request.slug}`
  const roots: Array<{ dir: string; repoRoot: string | null }> = [
    {
      dir: path.join(opts.vaultDir, '10-Projects', request.projectId ?? '_meetings', 'meetings', folder),
      repoRoot: null
    }
  ]
  if (request.alsoRepo) {
    const ws = await opts.findWorkspace(request.workspaceId as string)
    if (!ws) {
      sendJson(res, 404, { error: 'unknown workspace' })
      return
    }
    roots.push({ dir: path.join(ws.cwd, REPO_MEETINGS_DIR, folder), repoRoot: ws.cwd })
  }

  const targets = roots.flatMap((r) => request.files.map((f) => ({ path: path.join(r.dir, f.name), file: f })))
  const existing = targets.find((t) => fs.existsSync(t.path))
  if (existing) {
    sendJson(res, 409, { error: 'exists', path: existing.path })
    return
  }

  const written: string[] = []
  for (const root of roots) {
    fs.mkdirSync(root.dir, { recursive: true })
    if (root.repoRoot && request.keepOutOfGit) ensureGitignored(root.repoRoot)
  }
  for (const t of targets) {
    writeAtomic(t.path, Buffer.from(t.file.markdown, 'utf8'))
    written.push(t.path)
  }
  sendJson(res, 201, { written })
}
