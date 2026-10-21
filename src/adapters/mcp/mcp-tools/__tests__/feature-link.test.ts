// TASK-2589 — feature_link over a real SQLite service and real feature files.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SqliteTaskService } from '../../../../core/domain/sqlite-task-service'
import { linkFeature, FeatureLinkError, register } from '../feature-link'
import type { InstrumentedServer } from '../../instrumented-server'

let tmp: string
let svc: SqliteTaskService
let featureA: string
let featureB: string
let decision: string

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-link-'))
  svc = new SqliteTaskService(path.join(tmp, 'test.db'))
  await svc.ensureProject('p', 'P', tmp)
  await svc.createTask({ id: 'TASK-1', projectId: 'p', title: 'Goal' })
  const body = '## Why this exists\n\nPlain words.\n'
  featureA = (await svc.createKnowledge({ projectId: 'p', type: 'feature', scope: 'project', title: 'Feature A', body, refs: [] })).slug
  featureB = (await svc.createKnowledge({ projectId: 'p', type: 'feature', scope: 'project', title: 'Feature B', body, refs: [] })).slug
  decision = (await svc.createKnowledge({ projectId: 'p', type: 'decision', scope: 'project', title: 'A decision', body, refs: [] })).slug
})

afterEach(async () => {
  await svc.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const realizes = async (taskId: string): Promise<string[]> =>
  (await svc.getRelationshipsFrom(taskId, 'REALIZES')).map((r) => r.toId)

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (e) {
    return e instanceof FeatureLinkError ? e.code : `other: ${String(e)}`
  }
}

describe('linkFeature', () => {
  it('AC-1: links a task to a feature and the task realizes exactly that feature', async () => {
    const res = await linkFeature(svc, { taskId: 'TASK-1', featureSlug: featureA })
    expect(res).toEqual({ taskId: 'TASK-1', featureSlug: featureA, replaced: null })
    expect(await realizes('TASK-1')).toEqual([featureA])
  })

  it('AC-2: an unknown task answers UNKNOWN_TASK', async () => {
    expect(await codeOf(linkFeature(svc, { taskId: 'TASK-404', featureSlug: featureA }))).toBe('UNKNOWN_TASK')
  })

  it('AC-3: an unknown slug answers UNKNOWN_FEATURE', async () => {
    expect(await codeOf(linkFeature(svc, { taskId: 'TASK-1', featureSlug: 'no-such-slug' }))).toBe('UNKNOWN_FEATURE')
  })

  it('AC-4: a decision slug answers NOT_A_FEATURE', async () => {
    expect(await codeOf(linkFeature(svc, { taskId: 'TASK-1', featureSlug: decision }))).toBe('NOT_A_FEATURE')
  })

  it('AC-5: a second feature without replace answers ALREADY_LINKED naming the first, which stays the only edge', async () => {
    await linkFeature(svc, { taskId: 'TASK-1', featureSlug: featureA })
    let message = ''
    try {
      await linkFeature(svc, { taskId: 'TASK-1', featureSlug: featureB })
    } catch (e) {
      expect((e as FeatureLinkError).code).toBe('ALREADY_LINKED')
      message = (e as Error).message
    }
    expect(message).toContain(featureA)
    expect(await realizes('TASK-1')).toEqual([featureA])
  })

  it('AC-6: replace moves the task and reports what it replaced', async () => {
    await linkFeature(svc, { taskId: 'TASK-1', featureSlug: featureA })
    const res = await linkFeature(svc, { taskId: 'TASK-1', featureSlug: featureB, replace: true })
    expect(res.replaced).toBe(featureA)
    expect(await realizes('TASK-1')).toEqual([featureB])
  })

  it('AC-7: linking the same pair twice leaves one edge', async () => {
    await linkFeature(svc, { taskId: 'TASK-1', featureSlug: featureA })
    const again = await linkFeature(svc, { taskId: 'TASK-1', featureSlug: featureA })
    expect(again.replaced).toBeNull()
    expect(await realizes('TASK-1')).toEqual([featureA])
  })

  it('AC-8: a link writes no file — the feature .md is untouched', async () => {
    const file = (await svc.getKnowledge(featureA))!.filePath
    const before = fs.readFileSync(file, 'utf8')
    const mtime = fs.statSync(file).mtimeMs
    await linkFeature(svc, { taskId: 'TASK-1', featureSlug: featureA })
    expect(fs.statSync(file).mtimeMs).toBe(mtime)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })
})

describe('feature_link tool', () => {
  it('returns the error code in the body instead of throwing', async () => {
    let cb: ((args: unknown) => Promise<unknown>) | null = null
    const server = {
      registerTool: (_n: string, _c: unknown, fn: (args: unknown) => Promise<unknown>) => {
        cb = fn
      },
      registeredToolNames: []
    } as unknown as InstrumentedServer
    register(server, svc)
    const out = (await cb!({ taskId: 'TASK-404', featureSlug: featureA })) as { content: { text: string }[] }
    expect(JSON.parse(out.content[0].text)).toMatchObject({ error: 'UNKNOWN_TASK' })
  })
})
