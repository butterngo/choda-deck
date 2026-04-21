import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { resolveDataPaths } from './paths'

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try {
    fn()
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

const TMP = path.join(process.cwd(), 'tmp-test')

describe('resolveDataPaths', () => {
  it('defaults to <cwd>/data when no env set', () => {
    withEnv({ CHODA_DB_PATH: undefined, CHODA_DATA_DIR: undefined }, () => {
      const p = resolveDataPaths()
      expect(p.dataDir).toBe(path.join(process.cwd(), 'data'))
      expect(p.dbPath).toBe(path.join(process.cwd(), 'data', 'database', 'choda-deck.db'))
      expect(p.artifactsDir).toBe(path.join(process.cwd(), 'data', 'artifacts'))
      expect(p.backupsDir).toBe(path.join(process.cwd(), 'data', 'backups'))
    })
  })

  it('derives all paths from CHODA_DATA_DIR', () => {
    const dir = path.join(TMP, 'mydata')
    withEnv({ CHODA_DB_PATH: undefined, CHODA_DATA_DIR: dir }, () => {
      const p = resolveDataPaths()
      expect(p.dataDir).toBe(dir)
      expect(p.dbPath).toBe(path.join(dir, 'database', 'choda-deck.db'))
      expect(p.artifactsDir).toBe(path.join(dir, 'artifacts'))
      expect(p.backupsDir).toBe(path.join(dir, 'backups'))
    })
  })

  it('CHODA_DB_PATH overrides dbPath (legacy)', () => {
    const legacyDb = path.join(TMP, 'legacy', 'mydb.db')
    withEnv({ CHODA_DB_PATH: legacyDb, CHODA_DATA_DIR: undefined }, () => {
      const p = resolveDataPaths()
      expect(p.dbPath).toBe(legacyDb)
    })
  })

  it('electronDataDir used when no env set', () => {
    const electronDir = path.join(TMP, 'userData')
    withEnv({ CHODA_DB_PATH: undefined, CHODA_DATA_DIR: undefined }, () => {
      const p = resolveDataPaths(electronDir)
      expect(p.dataDir).toBe(electronDir)
      expect(p.dbPath).toBe(path.join(electronDir, 'database', 'choda-deck.db'))
      expect(p.backupsDir).toBe(path.join(electronDir, 'backups'))
    })
  })

  it('CHODA_DB_PATH wins over CHODA_DATA_DIR for dbPath', () => {
    const legacyDb = path.join(TMP, 'override.db')
    const dataDir = path.join(TMP, 'data')
    withEnv({ CHODA_DB_PATH: legacyDb, CHODA_DATA_DIR: dataDir }, () => {
      const p = resolveDataPaths()
      expect(p.dbPath).toBe(legacyDb)
    })
  })
})
