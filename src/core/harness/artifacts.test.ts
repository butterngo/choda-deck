import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionArtifactsDir, writePlanArtifact } from './artifacts'

describe('artifacts', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'choda-artifacts-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('getSessionArtifactsDir returns <dataDir>/data/artifacts/<sessionId>', () => {
    expect(getSessionArtifactsDir({ dataDir }, 'S42')).toBe(
      join(dataDir, 'data', 'artifacts', 'S42')
    )
  })

  it('writePlanArtifact creates dirs and writes plan.json', () => {
    const plan = { files: [{ path: 'src/x.ts', action: 'create', why: 'needed' }] }
    const filePath = writePlanArtifact({ dataDir }, 'S42', plan)

    expect(filePath).toBe(join(dataDir, 'data', 'artifacts', 'S42', 'plan.json'))
    expect(existsSync(filePath)).toBe(true)
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(plan)
  })

  it('overwrites existing plan.json without errors', () => {
    writePlanArtifact({ dataDir }, 'S42', { version: 1 })
    writePlanArtifact({ dataDir }, 'S42', { version: 2 })

    const filePath = join(dataDir, 'data', 'artifacts', 'S42', 'plan.json')
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ version: 2 })
  })
})
