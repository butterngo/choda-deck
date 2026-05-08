import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  identityKey,
  loadPathsMapping,
  savePathsMapping,
  setMapping,
  pathsMappingFile,
  PATHS_MAPPING_VERSION
} from './paths-mapping'
import type { WorkspaceIdentity } from './snapshot-types'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-paths-mapping-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const gitIdentity: WorkspaceIdentity = {
  workspaceId: 'main',
  projectId: 'choda-deck',
  canonicalGitRemote: 'github.com/butterngo/choda-deck',
  repoRelativeWorkspacePath: '',
  localFallbackKey: null
}

const subdirIdentity: WorkspaceIdentity = {
  workspaceId: 'docs',
  projectId: 'choda-deck',
  canonicalGitRemote: 'github.com/butterngo/choda-deck',
  repoRelativeWorkspacePath: 'docs',
  localFallbackKey: null
}

const localIdentity: WorkspaceIdentity = {
  workspaceId: 'sandbox',
  projectId: 'scratch',
  canonicalGitRemote: null,
  repoRelativeWorkspacePath: null,
  localFallbackKey: 'local:scratch:sandbox'
}

describe('identityKey', () => {
  it('combines canonical remote and repo-relative path for git workspaces', () => {
    expect(identityKey(gitIdentity)).toBe('github.com/butterngo/choda-deck:')
    expect(identityKey(subdirIdentity)).toBe('github.com/butterngo/choda-deck:docs')
  })

  it('returns the local fallback key for non-git workspaces', () => {
    expect(identityKey(localIdentity)).toBe('local:scratch:sandbox')
  })

  it('throws when identity has neither remote nor fallback', () => {
    expect(() =>
      identityKey({
        workspaceId: 'broken',
        projectId: 'p',
        canonicalGitRemote: null,
        repoRelativeWorkspacePath: null,
        localFallbackKey: null
      })
    ).toThrow(/no canonical remote/)
  })
})

describe('paths-mapping load/save', () => {
  it('returns an empty mapping when the file does not exist', () => {
    const m = loadPathsMapping(tmpDir)
    expect(m.version).toBe(PATHS_MAPPING_VERSION)
    expect(m.mappings).toEqual({})
  })

  it('persists and reloads mappings', () => {
    const m = setMapping(
      { version: PATHS_MAPPING_VERSION, mappings: {} },
      identityKey(gitIdentity),
      'C:\\dev\\choda-deck'
    )
    savePathsMapping(tmpDir, m)
    const reloaded = loadPathsMapping(tmpDir)
    expect(reloaded.mappings[identityKey(gitIdentity)]).toBe('C:\\dev\\choda-deck')
  })

  it('writes via canonical-json (sorted keys, LF endings)', () => {
    const m: { version: number; mappings: Record<string, string> } = {
      version: PATHS_MAPPING_VERSION,
      mappings: { z: '/z', a: '/a', m: '/m' }
    }
    savePathsMapping(tmpDir, m)
    const raw = fs.readFileSync(pathsMappingFile(tmpDir), 'utf8')
    expect(raw).not.toMatch(/\r/)
    const aIdx = raw.indexOf('"a"')
    const mIdx = raw.indexOf('"m"')
    const zIdx = raw.indexOf('"z"')
    expect(aIdx).toBeGreaterThan(-1)
    expect(aIdx).toBeLessThan(mIdx)
    expect(mIdx).toBeLessThan(zIdx)
  })

  it('rejects unsupported version on load', () => {
    fs.writeFileSync(
      pathsMappingFile(tmpDir),
      JSON.stringify({ version: 999, mappings: {} }),
      'utf8'
    )
    expect(() => loadPathsMapping(tmpDir)).toThrow(/unsupported version 999/)
  })

  it('atomic write — leaves no .tmp file on success', () => {
    savePathsMapping(tmpDir, { version: PATHS_MAPPING_VERSION, mappings: { foo: '/bar' } })
    const entries = fs.readdirSync(tmpDir)
    expect(entries).toContain('paths.local.json')
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
  })
})
