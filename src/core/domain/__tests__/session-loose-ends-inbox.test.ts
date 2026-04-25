import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from '../sqlite-task-service'
import { createLooseEndInboxes } from '../../../adapters/mcp/mcp-tools/session-tools'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test-loose-ends-inbox__.db')
let svc: SqliteTaskService

beforeAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('le', 'LooseEnds', '/tmp/le')
})

afterAll(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('createLooseEndInboxes', () => {
  it('returns empty array when looseEnds is undefined', () => {
    const session = svc.createSession({ projectId: 'le' })
    const ids = createLooseEndInboxes(svc, undefined, session)
    expect(ids).toEqual([])
  })

  it('returns empty array when looseEnds is empty', () => {
    const session = svc.createSession({ projectId: 'le' })
    const ids = createLooseEndInboxes(svc, [], session)
    expect(ids).toEqual([])
  })

  it('creates one inbox entry per loose end under the session project', () => {
    const session = svc.createSession({ projectId: 'le', taskId: 'TASK-X' })
    const looseEnds = ['flaky test in foo.spec.ts', 'method bar has dead branch', 'docs lag for baz']
    const ids = createLooseEndInboxes(svc, looseEnds, session)

    expect(ids).toHaveLength(3)
    for (const id of ids) {
      const item = svc.getInbox(id)
      expect(item).not.toBeNull()
      expect(item!.projectId).toBe('le')
      expect(item!.status).toBe('raw')
    }
  })

  it('embeds session id and task id in inbox content', () => {
    const session = svc.createSession({ projectId: 'le', taskId: 'TASK-602' })
    const ids = createLooseEndInboxes(svc, ['unrelated lint warning'], session)
    const item = svc.getInbox(ids[0])
    expect(item!.content).toContain('unrelated lint warning')
    expect(item!.content).toContain(session.id)
    expect(item!.content).toContain('TASK-602')
  })

  it('omits task id from content when session has no taskId', () => {
    const session = svc.createSession({ projectId: 'le' })
    const ids = createLooseEndInboxes(svc, ['observation'], session)
    const item = svc.getInbox(ids[0])
    expect(item!.content).toContain('observation')
    expect(item!.content).toContain(session.id)
    expect(item!.content).not.toMatch(/\(TASK-/)
  })
})
