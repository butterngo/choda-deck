import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  ImproveConfigError,
  improveConfigFile,
  loadImproveConfig,
  saveImproveConfig,
  validateImproveConfig,
  type ImproveConfigIssue
} from './improve-config'
import companion from './__fixtures__/companion-improve.json'

// TASK-2353 — each test names a field, so a validator that rejects for the
// wrong reason (or accepts) fails here instead of passing on "some error".

let ws: string

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-config-'))
})

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true })
})

function base(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(companion)) as Record<string, unknown>
}

function fields(raw: unknown): string[] {
  const r = validateImproveConfig(raw)
  return r.ok ? [] : r.errors.map((e: ImproveConfigIssue) => e.field)
}

describe('loadImproveConfig', () => {
  it('returns null when the workspace has no .choda/improve.json', () => {
    expect(loadImproveConfig(ws)).toBeNull()
  })

  it('throws ImproveConfigError naming the field when the file is invalid', () => {
    fs.mkdirSync(path.join(ws, '.choda'))
    fs.writeFileSync(improveConfigFile(ws), JSON.stringify({ ...base(), mode: 'x' }))
    expect(() => loadImproveConfig(ws)).toThrow(ImproveConfigError)
    try {
      loadImproveConfig(ws)
    } catch (err) {
      expect((err as ImproveConfigError).errors.map((e) => e.field)).toEqual(['mode'])
    }
  })

  it('reads a file with a UTF-8 BOM', () => {
    fs.mkdirSync(path.join(ws, '.choda'))
    fs.writeFileSync(improveConfigFile(ws), '﻿' + JSON.stringify(base()))
    expect(loadImproveConfig(ws)?.mode).toBe('manual')
  })
})

describe('validateImproveConfig', () => {
  it('rejects an unknown mode, naming `mode` and nothing else', () => {
    expect(fields({ ...base(), mode: 'x' })).toEqual(['mode'])
  })

  it('requires 3–8 criteria', () => {
    const criteria = base().criteria as unknown[]
    expect(fields({ ...base(), criteria: criteria.slice(0, 2) })).toEqual(['criteria'])
    const nine = Array.from({ length: 9 }, (_, i) => ({
      name: `c${i}`,
      by: 'agent',
      measure: 'looks fine',
      target: 4
    }))
    expect(fields({ ...base(), criteria: nine })).toEqual(['criteria'])
  })

  it('rejects an unknown auto measure on the exact criterion', () => {
    const c = base()
    ;(c.criteria as Record<string, unknown>[])[2].measure = 'foo'
    expect(fields(c)).toEqual(['criteria[2].measure'])
  })

  it('checks auto measure arguments: flow must exist, paths start with /', () => {
    const c = base()
    const criteria = c.criteria as Record<string, unknown>[]
    criteria[1].measure = 'lcp:tasks'
    criteria[4].measure = 'flow:missing'
    expect(fields(c)).toEqual(['criteria[1].measure', 'criteria[4].measure'])
  })

  it('does not apply auto measure kinds to agent criteria', () => {
    const c = base()
    ;(c.criteria as Record<string, unknown>[])[3].measure = 'foo'
    expect(validateImproveConfig(c).ok).toBe(true)
  })

  it('applies defaults for model / maxProposals / stopAfterFlat', () => {
    const r = validateImproveConfig(base())
    expect(r.ok && [r.config.model, r.config.maxProposals, r.config.stopAfterFlat]).toEqual([
      'sonnet',
      3,
      3
    ])
  })

  it('rejects maxProposals outside 1–5', () => {
    expect(fields({ ...base(), maxProposals: 6 })).toEqual(['maxProposals'])
    expect(fields({ ...base(), maxProposals: 0 })).toEqual(['maxProposals'])
  })

  it('accepts the choda-deck-companion fixture with no errors', () => {
    const r = validateImproveConfig(base())
    expect(r).toMatchObject({ ok: true })
    expect(r.ok && r.config.criteria.map((c) => c.by)).toEqual([
      'auto',
      'auto',
      'auto',
      'agent',
      'auto'
    ])
  })
})

describe('saveImproveConfig', () => {
  it('round-trips: save then load returns a deep-equal config', () => {
    const saved = saveImproveConfig(ws, { ...base(), maxProposals: 2 })
    expect(loadImproveConfig(ws)).toEqual(saved)
    expect(saved.maxProposals).toBe(2)
  })

  it('refuses an invalid config without touching the existing file', () => {
    saveImproveConfig(ws, base())
    const before = fs.readFileSync(improveConfigFile(ws), 'utf8')
    expect(() => saveImproveConfig(ws, { ...base(), mode: 'x' })).toThrow(ImproveConfigError)
    expect(fs.readFileSync(improveConfigFile(ws), 'utf8')).toBe(before)
    expect(fs.readdirSync(path.join(ws, '.choda'))).toEqual(['improve.json'])
  })
})
