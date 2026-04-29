import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { resolveWorkspaceId } from '../workspace-resolver'
import { WorkspaceResolutionError } from '../../../../core/domain/lifecycle/errors'
import type { WorkspaceRow } from '../../../../core/domain/repositories/workspace-repository'

const ws = (id: string, cwd: string): WorkspaceRow => ({
  id,
  projectId: 'p',
  label: id,
  cwd
})

const ROOT = path.resolve('/repo')
const NESTED = path.join(ROOT, 'packages', 'foo')
const OTHER = path.resolve('/elsewhere')

describe('resolveWorkspaceId', () => {
  it('returns explicit workspaceId without consulting cwd or workspaces', () => {
    const id = resolveWorkspaceId({
      explicitWorkspaceId: 'explicit',
      cwd: OTHER,
      workspaces: [ws('a', ROOT)]
    })
    expect(id).toBe('explicit')
  })

  it('matches cwd exactly to a workspace', () => {
    const id = resolveWorkspaceId({
      cwd: ROOT,
      workspaces: [ws('root', ROOT), ws('other', OTHER)]
    })
    expect(id).toBe('root')
  })

  it('matches cwd inside a workspace cwd (descendant)', () => {
    const id = resolveWorkspaceId({
      cwd: path.join(ROOT, 'src', 'foo.ts'),
      workspaces: [ws('root', ROOT)]
    })
    expect(id).toBe('root')
  })

  it('picks the longest (most specific) match for nested workspaces', () => {
    const id = resolveWorkspaceId({
      cwd: path.join(NESTED, 'src'),
      workspaces: [ws('root', ROOT), ws('nested', NESTED)]
    })
    expect(id).toBe('nested')
  })

  it('throws with workspace list when cwd matches no workspace', () => {
    expect(() =>
      resolveWorkspaceId({
        cwd: OTHER,
        workspaces: [ws('root', ROOT), ws('nested', NESTED)]
      })
    ).toThrow(WorkspaceResolutionError)

    try {
      resolveWorkspaceId({
        cwd: OTHER,
        workspaces: [ws('root', ROOT)]
      })
    } catch (e) {
      expect((e as Error).message).toContain('root')
      expect((e as Error).message).toContain(ROOT)
    }
  })

  it('throws when neither cwd nor workspaceId provided and project has workspaces', () => {
    expect(() =>
      resolveWorkspaceId({
        workspaces: [ws('root', ROOT)]
      })
    ).toThrow(WorkspaceResolutionError)
  })

  it('returns null when project has no registered workspaces', () => {
    expect(resolveWorkspaceId({ workspaces: [] })).toBeNull()
    expect(resolveWorkspaceId({ cwd: OTHER, workspaces: [] })).toBeNull()
  })

  it('does not match sibling paths with shared prefix (e.g. /repo vs /repo-backup)', () => {
    const sibling = path.resolve('/repo-backup')
    expect(() =>
      resolveWorkspaceId({
        cwd: sibling,
        workspaces: [ws('root', ROOT)]
      })
    ).toThrow(WorkspaceResolutionError)
  })

  it('normalizes trailing separators', () => {
    const id = resolveWorkspaceId({
      cwd: ROOT + path.sep,
      workspaces: [ws('root', ROOT)]
    })
    expect(id).toBe('root')
  })
})
