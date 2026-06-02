import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { splitLines } from '../utils/lines'

// TASK-985 (ADR-031 Tier 2) — derive `resumePoint` from the Claude Code transcript.
// Pure parsing/extraction lives here and is unit-tested directly; the FS locator
// (`TranscriptOpsImpl`) is a thin wrapper, stubbed in tests per the repo's
// "thin git/IO wrapper" pattern. Best-effort: any miss returns null and the caller
// falls back to the AI-supplied value (no incorrect data is ever written).

export interface TranscriptRow {
  type?: string
  message?: { role?: string; content?: unknown }
  gitBranch?: string
  timestamp?: string
  cwd?: string
  sessionId?: string
}

interface TextBlock {
  type: 'text'
  text: string
}

function isTextBlock(b: unknown): b is TextBlock {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as { type?: unknown }).type === 'text' &&
    typeof (b as { text?: unknown }).text === 'string'
  )
}

/**
 * Slug a cwd into the Claude Code project-dir name: every non-alphanumeric char
 * → '-'. Verified live: `C:\dev\choda-deck` → `C--dev-choda-deck`. Worktrees slug
 * to their own dir, so the session's actual cwd must be passed (not the repo root).
 */
export function cwdToProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Parse JSONL transcript content → rows, skipping malformed lines (CRLF-safe). */
export function parseTranscript(content: string): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const line of splitLines(content)) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line) as TranscriptRow)
    } catch {
      /* malformed line — skip */
    }
  }
  return rows
}

/**
 * The last *text-bearing* assistant turn, trimmed. Walks backward because the
 * literal last assistant turn is frequently a `tool_use`-only block with no text.
 * Returns null when no assistant text exists.
 */
export function extractResumePoint(rows: TranscriptRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.type !== 'assistant') continue
    const content = r.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter(isTextBlock)
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return null
}

export interface ReadResumePointOpts {
  cwd: string
  ccSessionId?: string | null
  startedAt: string
  endedAt?: string | null
  /** Override home dir (tests). Defaults to os.homedir(). */
  homeDir?: string
}

export interface TranscriptOps {
  readResumePoint(opts: ReadResumePointOpts): string | null
}

export class TranscriptOpsImpl implements TranscriptOps {
  readResumePoint(opts: ReadResumePointOpts): string | null {
    try {
      const base = path.join(
        opts.homeDir ?? os.homedir(),
        '.claude',
        'projects',
        cwdToProjectSlug(opts.cwd)
      )
      if (!fs.existsSync(base)) return null

      // Primary path — deterministic location by captured CC session id.
      if (opts.ccSessionId) {
        const file = path.join(base, `${opts.ccSessionId}.jsonl`)
        if (fs.existsSync(file)) {
          return extractResumePoint(parseTranscript(fs.readFileSync(file, 'utf8')))
        }
      }

      // Fallback — heuristic correlation. Newest .jsonl modified at/after the
      // session start (mtime proxy avoids reading every transcript). Fragile under
      // parallel sessions in one cwd, hence fallback-only (ADR-031).
      const sinceMs = Date.parse(opts.startedAt)
      const candidates = fs
        .readdirSync(base)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const full = path.join(base, f)
          let mtimeMs = 0
          try {
            mtimeMs = fs.statSync(full).mtimeMs
          } catch {
            /* race: file vanished */
          }
          return { full, mtimeMs }
        })
        .filter((c) => c.mtimeMs > 0 && (Number.isNaN(sinceMs) || c.mtimeMs >= sinceMs))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)

      if (candidates.length === 0) return null
      return extractResumePoint(parseTranscript(fs.readFileSync(candidates[0].full, 'utf8')))
    } catch {
      // Missing dir, permission error, unreadable file — derivation is best-effort.
      return null
    }
  }
}
