import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import {
  HypothesisNotFoundError,
  HypothesisTransitionError,
  InvestigationNotFoundError,
  InvestigationStatusError
} from './errors'

const TEST_DB = path.join(__dirname, '__test-investigation-lifecycle__.db')
let svc: SqliteTaskService

beforeEach(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  await svc.ensureProject('proj-i', 'Investigation Project', '/tmp/i')
})

afterEach(async () => {
  await svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('startInvestigation (AC-1)', () => {
  it('creates an exploring investigation, returns id', async () => {
    const inv = await svc.startInvestigation({ symptom: 'Test button does not work' })
    expect(inv.id).toMatch(/^INV-/)
    expect(inv.status).toBe('exploring')
    expect(inv.symptom).toBe('Test button does not work')
    expect(inv.hypotheses).toEqual([])
    expect(inv.evidence).toEqual([])
  })

  it('allows optional task/session binding (standalone allowed)', async () => {
    const bound = await svc.startInvestigation({ symptom: 'x', taskId: 'TASK-1', sessionId: 'S-1' })
    expect(bound.taskId).toBe('TASK-1')
    expect(bound.sessionId).toBe('S-1')
    const standalone = await svc.startInvestigation({ symptom: 'y' })
    expect(standalone.taskId).toBeNull()
    expect(standalone.sessionId).toBeNull()
  })
})

describe('hypothesis lifecycle (AC-2)', () => {
  it('adds a hypothesis as testing, then transitions and persists ruled_out', async () => {
    const inv = await svc.startInvestigation({ symptom: 'symptom' })
    const h1 = await svc.addHypothesis(inv.id, 'workspace is null')
    const h2 = await svc.addHypothesis(inv.id, 'definitionJson missing upstream')
    expect(h1.status).toBe('testing')

    await svc.setHypothesisStatus(h1.id, 'ruled_out')
    const confirmed = await svc.setHypothesisStatus(h2.id, 'confirmed')
    expect(confirmed.status).toBe('confirmed')

    // Ruled-out hypotheses persist and are returned on read.
    const full = await svc.getInvestigation(inv.id)
    expect(full?.hypotheses).toHaveLength(2)
    expect(full?.hypotheses.find((h) => h.id === h1.id)?.status).toBe('ruled_out')
  })

  it('rejects adding a hypothesis to a resolved investigation', async () => {
    const inv = await svc.startInvestigation({ symptom: 's' })
    await svc.resolveInvestigation(inv.id, { rootCause: 'rc', fixSummary: 'fix' })
    await expect(svc.addHypothesis(inv.id, 'late idea')).rejects.toThrow(InvestigationStatusError)
  })

  it('rejects an illegal hypothesis transition (terminal cannot re-transition)', async () => {
    const inv = await svc.startInvestigation({ symptom: 's' })
    const h = await svc.addHypothesis(inv.id, 'h')
    await svc.setHypothesisStatus(h.id, 'confirmed')
    await expect(svc.setHypothesisStatus(h.id, 'ruled_out')).rejects.toThrow(
      HypothesisTransitionError
    )
  })

  it('throws HypothesisNotFoundError on unknown hypothesis', async () => {
    await expect(svc.setHypothesisStatus('HYP-999', 'confirmed')).rejects.toThrow(
      HypothesisNotFoundError
    )
  })
})

describe('evidence (AC-3)', () => {
  it('attaches typed evidence to the investigation and to a hypothesis', async () => {
    const inv = await svc.startInvestigation({ symptom: 's' })
    const h = await svc.addHypothesis(inv.id, 'h')

    const e1 = await svc.addEvidence({ investigationId: inv.id, type: 'log', ref: 'app.log:42' })
    const e2 = await svc.addEvidence({
      investigationId: inv.id,
      hypothesisId: h.id,
      type: 'screenshot',
      ref: 'shot.png',
      note: 'button greyed out'
    })
    expect(e1.hypothesisId).toBeNull()
    expect(e2.hypothesisId).toBe(h.id)

    const full = await svc.getInvestigation(inv.id)
    expect(full?.evidence).toHaveLength(2)
  })

  it('throws InvestigationNotFoundError on unknown investigation (AC-6)', async () => {
    await expect(
      svc.addEvidence({ investigationId: 'INV-999', type: 'log', ref: 'x' })
    ).rejects.toThrow(InvestigationNotFoundError)
  })

  it('throws HypothesisNotFoundError when the hypothesis belongs to another investigation', async () => {
    const a = await svc.startInvestigation({ symptom: 'a' })
    const b = await svc.startInvestigation({ symptom: 'b' })
    const hb = await svc.addHypothesis(b.id, 'hb')
    await expect(
      svc.addEvidence({ investigationId: a.id, hypothesisId: hb.id, type: 'log', ref: 'x' })
    ).rejects.toThrow(HypothesisNotFoundError)
  })
})

describe('resolveInvestigation (AC-4)', () => {
  it('resolves and returns a non-written knowledge gotcha draft', async () => {
    const inv = await svc.startInvestigation({ symptom: 'validation fails on expression node' })
    const r = await svc.resolveInvestigation(inv.id, {
      rootCause: 'inputData empty — no upstream context',
      fixSummary: 'use inputNodes[0].data',
      patternTag: 'expression-no-upstream-data'
    })

    expect(r.investigation.status).toBe('resolved')
    expect(r.investigation.resolvedAt).toBeTruthy()
    expect(r.knowledgeDraft.type).toBe('gotcha')
    expect(r.knowledgeDraft.patternTag).toBe('expression-no-upstream-data')
    expect(r.knowledgeDraft.body).toContain('inputData empty')

    // Draft is NOT written to the knowledge layer.
    expect(await svc.listKnowledge({ projectId: 'proj-i' })).toHaveLength(0)
  })

  it('throws InvestigationStatusError when already resolved (AC-6)', async () => {
    const inv = await svc.startInvestigation({ symptom: 's' })
    await svc.resolveInvestigation(inv.id, { rootCause: 'rc', fixSummary: 'fix' })
    await expect(
      svc.resolveInvestigation(inv.id, { rootCause: 'again', fixSummary: 'again' })
    ).rejects.toThrow(InvestigationStatusError)
  })

  it('throws InvestigationNotFoundError on unknown id', async () => {
    await expect(
      svc.resolveInvestigation('INV-999', { rootCause: 'x', fixSummary: 'y' })
    ).rejects.toThrow(InvestigationNotFoundError)
  })
})

describe('getInvestigation cross-session read (AC-5)', () => {
  it('returns full nested state for a fresh reader', async () => {
    const inv = await svc.startInvestigation({ symptom: 'button broken' })
    const h1 = await svc.addHypothesis(inv.id, 'ruled out')
    await svc.addHypothesis(inv.id, 'confirmed one')
    await svc.setHypothesisStatus(h1.id, 'ruled_out')
    await svc.addEvidence({ investigationId: inv.id, type: 'network', ref: 'POST /test 400' })

    const full = await svc.getInvestigation(inv.id)
    expect(full?.symptom).toBe('button broken')
    expect(full?.hypotheses).toHaveLength(2)
    expect(full?.evidence).toHaveLength(1)
  })

  it('returns null for an unknown investigation', async () => {
    expect(await svc.getInvestigation('INV-999')).toBeNull()
  })
})

describe('transaction rollback (AC-6 — no partial write)', () => {
  it('rolls back evidence insert when the write throws mid-transaction', async () => {
    const inv = await svc.startInvestigation({ symptom: 'rollback' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lifecycle = (svc as any).investigationLifecycle
    const orig = lifecycle.investigations.insertEvidence.bind(lifecycle.investigations)
    lifecycle.investigations.insertEvidence = () => {
      throw new Error('simulated failure')
    }

    await expect(
      svc.addEvidence({ investigationId: inv.id, type: 'log', ref: 'x' })
    ).rejects.toThrow('simulated failure')

    lifecycle.investigations.insertEvidence = orig

    expect((await svc.getInvestigation(inv.id))?.evidence).toHaveLength(0)
  })
})
