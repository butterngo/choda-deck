#!/usr/bin/env node
/**
 * One-shot migration: move legacy choda-deck.db → data/database/choda-deck.db
 *
 * Idempotent: no-op if target already exists or source doesn't exist.
 * Run from repo root: node scripts/migrate-data-layout.mjs
 */

import { existsSync, mkdirSync, renameSync, copyFileSync, unlinkSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(__dirname, '..')

const legacyDb = join(repoRoot, 'choda-deck.db')
const targetDir = join(repoRoot, 'data', 'database')
const targetDb = join(targetDir, 'choda-deck.db')

if (!existsSync(legacyDb)) {
  console.log('[migrate] No legacy choda-deck.db found — nothing to do.')
  process.exit(0)
}

if (existsSync(targetDb)) {
  console.log(`[migrate] Target already exists at ${targetDb} — skipping.`)
  process.exit(0)
}

mkdirSync(targetDir, { recursive: true })

// Try rename first (atomic), fall back to copy if file is locked
try {
  renameSync(legacyDb, targetDb)
  console.log(`[migrate] Moved ${legacyDb} → ${targetDb}`)
} catch (err) {
  if (err.code === 'EBUSY' || err.code === 'EPERM') {
    copyFileSync(legacyDb, targetDb)
    console.log(`[migrate] Copied ${legacyDb} → ${targetDb} (file was busy — delete original after restarting Claude)`)
  } else {
    throw err
  }
}

// Handle WAL/SHM sidecars
for (const ext of ['-shm', '-wal']) {
  const sidecar = legacyDb + ext
  const targetSidecar = targetDb + ext
  if (existsSync(sidecar)) {
    try {
      renameSync(sidecar, targetSidecar)
    } catch {
      copyFileSync(sidecar, targetSidecar)
    }
    console.log(`[migrate] Moved ${sidecar} → ${targetSidecar}`)
  }
}

console.log('[migrate] Done.')
