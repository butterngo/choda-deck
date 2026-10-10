import * as fs from 'fs'
import * as path from 'path'

// TASK-2353 — the per-workspace improve loop config (TASK-2352), stored at
// <workspace>/.choda/improve.json. Pure apart from the two file helpers at the
// bottom: no DB, no model. The CLI (TASK-2356), the companion routes (TASK-2357)
// and the skill (TASK-2358) all read it through loadImproveConfig.

export const IMPROVE_CONFIG_PATH = path.join('.choda', 'improve.json')

export const IMPROVE_MODES = ['off', 'manual', 'scheduled'] as const
export const CRITERION_BY = ['auto', 'agent', 'you'] as const
/** `auto` measures the CLI knows how to take; `test` stands alone, the rest take an argument. */
export const AUTO_MEASURE_KINDS = ['test', 'lcp', 'console', 'axe', 'flow'] as const

export const MIN_CRITERIA = 3
export const MAX_CRITERIA = 8
export const DEFAULT_MODEL = 'sonnet'
export const DEFAULT_MAX_PROPOSALS = 3
export const DEFAULT_STOP_AFTER_FLAT = 3

export type ImproveMode = (typeof IMPROVE_MODES)[number]
export type CriterionBy = (typeof CRITERION_BY)[number]

export interface ImproveFlow {
  name: string
  steps: string
  spec?: string
}

export interface ImproveCriterion {
  name: string
  by: CriterionBy
  /** `auto`: a measure kind (`test`, `lcp:/path`, …). `agent` / `you`: what to judge, in words. */
  measure: string
  target: string | number
  /** Ticked "good enough" in the UI — the loop stops proposing for it. */
  good?: boolean
}

export interface ImproveConfig {
  mode: ImproveMode
  url: string
  startCmd?: string
  testCmd?: string
  pages: string[]
  flows: ImproveFlow[]
  criteria: ImproveCriterion[]
  model: string
  maxProposals: number
  stopAfterFlat: number
}

export interface ImproveConfigIssue {
  /** Dotted path of the offending field, e.g. `criteria[2].measure`. */
  field: string
  message: string
}

export type ImproveConfigResult =
  | { ok: true; config: ImproveConfig }
  | { ok: false; errors: ImproveConfigIssue[] }

export class ImproveConfigError extends Error {
  constructor(
    readonly file: string,
    readonly errors: ImproveConfigIssue[]
  ) {
    super(`${file}: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`)
    this.name = 'ImproveConfigError'
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function intInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

function checkAutoMeasure(measure: string, flowNames: Set<string>): string | null {
  const [kind, ...rest] = measure.split(':')
  const arg = rest.join(':')
  if (!(AUTO_MEASURE_KINDS as readonly string[]).includes(kind)) {
    return `must be one of ${AUTO_MEASURE_KINDS.map((k) => (k === 'test' ? k : `${k}:<arg>`)).join(', ')}`
  }
  if (kind === 'test') return arg ? '`test` takes no argument' : null
  if (!arg) return `\`${kind}\` needs an argument (${kind}:<${kind === 'flow' ? 'name' : 'path'}>)`
  if (kind === 'flow' && !flowNames.has(arg)) return `no flow named "${arg}" in flows`
  if (kind !== 'flow' && !arg.startsWith('/')) return `path must start with "/"`
  return null
}

function validateFlows(raw: unknown, errors: ImproveConfigIssue[]): ImproveFlow[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    errors.push({ field: 'flows', message: 'must be an array' })
    return []
  }
  return raw.map((f, i) => {
    const field = `flows[${i}]`
    if (!isObject(f)) {
      errors.push({ field, message: 'must be an object' })
      return { name: '', steps: '' }
    }
    if (!nonEmpty(f.name)) errors.push({ field: `${field}.name`, message: 'is required' })
    if (!nonEmpty(f.steps)) errors.push({ field: `${field}.steps`, message: 'is required' })
    if (f.spec !== undefined && !nonEmpty(f.spec)) {
      errors.push({ field: `${field}.spec`, message: 'must be a non-empty path when set' })
    }
    const flow: ImproveFlow = { name: String(f.name ?? ''), steps: String(f.steps ?? '') }
    if (nonEmpty(f.spec)) flow.spec = f.spec
    return flow
  })
}

function validateCriteria(
  raw: unknown,
  flowNames: Set<string>,
  errors: ImproveConfigIssue[]
): ImproveCriterion[] {
  if (!Array.isArray(raw) || raw.length < MIN_CRITERIA || raw.length > MAX_CRITERIA) {
    errors.push({
      field: 'criteria',
      message: `must be an array of ${MIN_CRITERIA}–${MAX_CRITERIA} criteria`
    })
    return []
  }
  return raw.map((c, i) => {
    const field = `criteria[${i}]`
    if (!isObject(c)) {
      errors.push({ field, message: 'must be an object' })
      return { name: '', by: 'auto', measure: '', target: '' }
    }
    if (!nonEmpty(c.name)) errors.push({ field: `${field}.name`, message: 'is required' })
    if (!(CRITERION_BY as readonly unknown[]).includes(c.by)) {
      errors.push({ field: `${field}.by`, message: `must be one of ${CRITERION_BY.join(', ')}` })
    }
    if (!nonEmpty(c.measure)) {
      errors.push({ field: `${field}.measure`, message: 'is required' })
    } else if (c.by === 'auto') {
      const problem = checkAutoMeasure(c.measure.trim(), flowNames)
      if (problem) errors.push({ field: `${field}.measure`, message: problem })
    }
    const targetOk = nonEmpty(c.target) || (typeof c.target === 'number' && isFinite(c.target))
    if (!targetOk) errors.push({ field: `${field}.target`, message: 'is required' })
    if (c.good !== undefined && typeof c.good !== 'boolean') {
      errors.push({ field: `${field}.good`, message: 'must be a boolean' })
    }
    const criterion: ImproveCriterion = {
      name: String(c.name ?? ''),
      by: c.by as CriterionBy,
      measure: typeof c.measure === 'string' ? c.measure.trim() : '',
      target: c.target as string | number
    }
    if (c.good === true) criterion.good = true
    return criterion
  })
}

/** Validate an untrusted value and apply defaults. Every issue names its field. */
export function validateImproveConfig(raw: unknown): ImproveConfigResult {
  const errors: ImproveConfigIssue[] = []
  if (!isObject(raw)) return { ok: false, errors: [{ field: '', message: 'must be an object' }] }

  if (!(IMPROVE_MODES as readonly unknown[]).includes(raw.mode)) {
    errors.push({ field: 'mode', message: `must be one of ${IMPROVE_MODES.join(', ')}` })
  }
  if (!nonEmpty(raw.url) || !/^https?:\/\//.test(raw.url)) {
    errors.push({ field: 'url', message: 'must be an http(s) URL' })
  }
  for (const key of ['startCmd', 'testCmd'] as const) {
    if (raw[key] !== undefined && !nonEmpty(raw[key])) {
      errors.push({ field: key, message: 'must be a non-empty command when set' })
    }
  }
  const pages = Array.isArray(raw.pages) ? raw.pages : null
  if (!pages || pages.length === 0) {
    errors.push({ field: 'pages', message: 'must list at least one page path' })
  } else {
    pages.forEach((p, i) => {
      if (!nonEmpty(p) || !p.startsWith('/')) {
        errors.push({ field: `pages[${i}]`, message: 'must be a path starting with "/"' })
      }
    })
  }
  const flows = validateFlows(raw.flows, errors)
  const criteria = validateCriteria(raw.criteria, new Set(flows.map((f) => f.name)), errors)

  const model = raw.model ?? DEFAULT_MODEL
  if (!nonEmpty(model)) errors.push({ field: 'model', message: 'must be a model name' })
  const maxProposals = raw.maxProposals ?? DEFAULT_MAX_PROPOSALS
  if (!intInRange(maxProposals, 1, 5)) {
    errors.push({ field: 'maxProposals', message: 'must be an integer 1–5' })
  }
  const stopAfterFlat = raw.stopAfterFlat ?? DEFAULT_STOP_AFTER_FLAT
  if (!intInRange(stopAfterFlat, 1, 30)) {
    errors.push({ field: 'stopAfterFlat', message: 'must be an integer 1–30' })
  }

  if (errors.length > 0) return { ok: false, errors }
  const config: ImproveConfig = {
    mode: raw.mode as ImproveMode,
    url: raw.url as string,
    pages: pages as string[],
    flows,
    criteria,
    model: model as string,
    maxProposals: maxProposals as number,
    stopAfterFlat: stopAfterFlat as number
  }
  if (nonEmpty(raw.startCmd)) config.startCmd = raw.startCmd
  if (nonEmpty(raw.testCmd)) config.testCmd = raw.testCmd
  return { ok: true, config }
}

export function improveConfigFile(workspaceCwd: string): string {
  return path.join(workspaceCwd, IMPROVE_CONFIG_PATH)
}

/**
 * The workspace's config, or null when it has none — the loop treats a missing
 * file as `mode: off`. A file that exists but is unreadable JSON or invalid
 * throws ImproveConfigError: a broken config must be fixed, not silently ignored.
 */
export function loadImproveConfig(workspaceCwd: string): ImproveConfig | null {
  const file = improveConfigFile(workspaceCwd)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''))
  } catch (err) {
    throw new ImproveConfigError(file, [
      { field: '', message: `not JSON: ${(err as Error).message}` }
    ])
  }
  const result = validateImproveConfig(raw)
  if (!result.ok) throw new ImproveConfigError(file, result.errors)
  return result.config
}

/**
 * Validate, then write via a sibling temp file + rename (the adapter's
 * atomic-file pattern; core cannot import the adapter). Throws
 * ImproveConfigError without touching the file when the config is invalid.
 */
export function saveImproveConfig(workspaceCwd: string, config: unknown): ImproveConfig {
  const file = improveConfigFile(workspaceCwd)
  const result = validateImproveConfig(config)
  if (!result.ok) throw new ImproveConfigError(file, result.errors)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.improve.json.${process.pid}.tmp`)
  try {
    fs.writeFileSync(tmp, JSON.stringify(result.config, null, 2) + '\n')
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // The temp file may never have been created; the write error is what matters.
    }
    throw err
  }
  return result.config
}
