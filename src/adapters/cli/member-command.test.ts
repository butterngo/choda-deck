// TASK-2243 — member CLI argument handling, against a fake repository (no DB).

import { describe, expect, it } from 'vitest'
import { runMemberCommand } from './member-command'

const repo = {
  add: async () => 'added' as const,
  remove: async () => 'removed' as const,
  listProjectsFor: async () => []
}

async function run(sub: string | undefined, ...args: string[]): Promise<{ code: number; err: string }> {
  let err = ''
  const code = await runMemberCommand(sub, args, repo, { out: () => {}, err: (t) => (err += t) })
  return { code, err }
}

describe('member CLI usage errors', () => {
  it('an unknown subcommand exits 2 with the help text', async () => {
    const r = await run('rename', 'an')
    expect(r.code).toBe(2)
    expect(r.err).toContain('member add <member> <projectId>')
  })

  it('add without a project id exits 2', async () => {
    expect((await run('add', 'an')).code).toBe(2)
  })

  it('remove with an extra argument exits 2', async () => {
    expect((await run('remove', 'an', 'p', 'x')).code).toBe(2)
  })

  it('list without a member exits 2', async () => {
    expect((await run('list')).code).toBe(2)
  })
})
