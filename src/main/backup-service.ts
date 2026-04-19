import { readdirSync, statSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'

export interface BackupInfo {
  filename: string
  date: string
  size: number
  mtimeMs: number
}

const FILENAME_RE = /^choda-deck-\d{4}-\d{2}-\d{2}\.db$/
const DAY_MS = 24 * 60 * 60 * 1000

export function backupDir(userData: string): string {
  return join(userData, 'backups')
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function todayStamp(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseBackup(dir: string, filename: string): BackupInfo | null {
  if (!FILENAME_RE.test(filename)) return null
  const full = join(dir, filename)
  const st = statSync(full)
  return {
    filename,
    date: filename.slice('choda-deck-'.length, 'choda-deck-'.length + 10),
    size: st.size,
    mtimeMs: st.mtimeMs
  }
}

export function listBackups(userData: string): BackupInfo[] {
  const dir = backupDir(userData)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((f) => parseBackup(dir, f))
    .filter((b): b is BackupInfo => b !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function shouldRunDailyBackup(userData: string, now: Date = new Date()): boolean {
  const backups = listBackups(userData)
  if (backups.length === 0) return true
  return now.getTime() - backups[0].mtimeMs >= DAY_MS
}

export function pruneOld(userData: string, keep: number): void {
  const backups = listBackups(userData)
  if (backups.length <= keep) return
  const dir = backupDir(userData)
  for (const b of backups.slice(keep)) {
    try {
      unlinkSync(join(dir, b.filename))
    } catch (err) {
      console.error(`[backup] failed to prune ${b.filename}:`, err)
    }
  }
}

export interface Backupable {
  backup(absolutePath: string): void
}

export function runBackup(db: Backupable, userData: string, now: Date = new Date()): BackupInfo {
  const dir = backupDir(userData)
  ensureDir(dir)
  const filename = `choda-deck-${todayStamp(now)}.db`
  const target = join(dir, filename)
  if (existsSync(target)) unlinkSync(target)
  db.backup(target)
  pruneOld(userData, 7)
  const st = statSync(target)
  return { filename, date: todayStamp(now), size: st.size, mtimeMs: st.mtimeMs }
}
