// TASK-1914 — the AC grader, extracted from the HTTP route it was born in.
//
// It moved because it acquired a second caller: the `ac_review` MCP tool, so a
// skill can grade criteria at the moment they are cheapest to fix, rather than
// only from the companion's web UI (`grep -rl ac_review ~/.claude/skills/`
// returned nothing until now).
//
// The extraction is the point, not a tidy-up. A second copy of the five tests
// would be a second STANDARD: it would drift from this one the first time either
// is edited, and nothing would report that the two callers had begun grading by
// different rules. AC-2 pins the two prompts as byte-identical for that reason.
//
// What stays out of here: HTTP status codes and MCP text formatting. This module
// answers what happened; each caller says it in its own dialect.

import { AiError, type AiErrorKind } from './ai-review'
import { askAzureJson, resolveAzureConfig } from './azure-review'

export interface AcVerdict {
  index: number
  text: string
  /**
   * TASK-1913 — three states, because two could not tell them apart.
   *
   * `unanswered` means the model returned no row for this index. It used to be
   * reported as `ok`, i.e. approved: the grader was at its most confident about
   * the one criterion it had said nothing about.
   */
  verdict: 'ok' | 'weak' | 'unanswered'
  /** Which of the five tests it fails, why it is unanswered, or null when ok. */
  concern: string | null
  /** A rewritten criterion to READ. Never written back. */
  suggestion: string | null
}

/** What an `unanswered` row says, so a reader gets a reason and not just a word. */
export const UNANSWERED = 'The model returned no verdict for this criterion.'

/**
 * The five tests, as sent to the model. Exported so a test can assert both
 * callers send the SAME bytes — see the module comment.
 */
export const SYSTEM = [
  'You grade acceptance criteria against a fixed standard, and you report only what the standard says.',
  'A criterion is WEAK if it fails any of these five tests:',
  '(1) falsifiable — you can state in one line what a broken implementation would produce, and that output differs from the passing one;',
  '(2) observable with the surface named — it says WHERE to look: a command exit code, a response field, an artifact on disk, a rendered element.',
  'Phrases like "works correctly", "properly handles" and "is robust" name no surface and always fail this test;',
  '(3) one verdict — a criterion joined by "and" covering two separate claims is two criteria wearing one checkbox;',
  '(4) classified — it says whether verifying it needs a machine, a human, or a decision;',
  '(5) tickable — it is a checkbox line, not prose or a numbered heading.',
  'A criterion passing all five is ok.',
  'Do not invent concerns to seem useful, and do not soften a real one.',
  'For a weak criterion, name the failing test in concern and put a rewritten criterion in suggestion.',
  'For an ok criterion, concern and suggestion are both null.',
  'Answer for every criterion you are given, using its number as index.'
].join(' ')

const AC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'verdict', 'concern', 'suggestion'],
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: ['ok', 'weak'] },
          concern: { type: ['string', 'null'] },
          suggestion: { type: ['string', 'null'] }
        }
      }
    }
  }
} as const

interface RawVerdict {
  index?: number
  verdict?: string
  concern?: string | null
  suggestion?: string | null
}

/**
 * The criteria, in the order `ac_check` indexes them — every `- [ ]` or `- [x]`
 * line under `## Acceptance`, and nothing else.
 *
 * Sending the whole body would grade the Context and the Test Plan too, which is
 * not what the standard is about and would spend tokens saying so. It would also
 * make the returned indexes meaningless: `ac_check` counts checkbox lines in this
 * section, and a verdict that cannot be pointed back at a checkbox is a verdict
 * nobody can act on.
 */
export function parseAcceptance(body: string): string[] {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+Acceptance\s*$/i.test(l.trim()))
  if (start === -1) return []

  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // Any following h2 ends the section — ## Test Plan, ## Related, anything.
    if (/^##\s+/.test(line.trim())) break
    const m = /^\s*-\s*\[[ xX]\]\s*(.+)$/.exec(line)
    if (m && m[1] !== undefined) out.push(m[1].trim())
  }
  return out
}

/**
 * What happened, in terms both callers can translate. Deliberately NOT statuses:
 * the HTTP route owes a reader 404/501/429/502, the MCP tool owes a caller a
 * sentence, and neither should have to reverse-engineer the other's vocabulary.
 */
export type GradeResult =
  | { kind: 'graded'; criteria: AcVerdict[] }
  | { kind: 'no-criteria' }
  | { kind: 'no-provider' }
  | { kind: 'failed'; errorKind: AiErrorKind; retryAfter: string | null }

export interface GradeOptions {
  /** The task's body. Parsed here rather than by the caller, so both parse alike. */
  body: string
  dataDir: string | undefined
  model?: string
  fetchImpl?: typeof fetch
}

/**
 * Grade one task's acceptance criteria. One task per call, never a list —
 * `adr-when-this-project-may-call-a-model` §2: a function that fanned out would
 * turn one caller decision into N charges.
 */
export async function gradeAcceptance(opts: GradeOptions): Promise<GradeResult> {
  // Read the criteria BEFORE the provider is resolved, so a task with nothing to
  // grade costs nothing even on a fully configured machine. Calling a model to
  // grade an empty list is the clearest possible waste.
  const criteria = parseAcceptance(opts.body)
  if (criteria.length === 0) return { kind: 'no-criteria' }

  let cfg
  try {
    cfg = opts.dataDir ? resolveAzureConfig(opts.dataDir) : null
  } catch (err) {
    // A malformed provider file is not "no provider configured" — that would
    // silently degrade a misconfiguration into a normal state.
    if (err instanceof AiError) return { kind: 'failed', errorKind: err.kind, retryAfter: null }
    throw err
  }
  if (cfg === null) return { kind: 'no-provider' }

  try {
    const answer = await askAzureJson<{ criteria?: RawVerdict[] }>({
      cfg,
      system: SYSTEM,
      user: criteria.map((text, i) => `${i}. ${text}`).join('\n'),
      schema: AC_SCHEMA,
      schemaName: 'ac_review',
      model: opts.model,
      fetchImpl: opts.fetchImpl
    })

    const byIndex = new Map<number, RawVerdict>()
    for (const v of answer.criteria ?? []) {
      if (typeof v.index === 'number') byIndex.set(v.index, v)
    }

    // Every criterion is answered for, whether or not the model mentioned it —
    // and the two cases are DIFFERENT ANSWERS (TASK-1913). This used to collapse
    // them: a criterion missing from the response rendered as `ok`, which is
    // approval, in the one direction this feature must never fail in.
    const out: AcVerdict[] = criteria.map((text, i) => {
      const got = byIndex.get(i)
      if (got === undefined) {
        return { index: i, text, verdict: 'unanswered', concern: UNANSWERED, suggestion: null }
      }
      return {
        index: i,
        text,
        verdict: got.verdict === 'weak' ? 'weak' : 'ok',
        concern: typeof got.concern === 'string' ? got.concern : null,
        suggestion: typeof got.suggestion === 'string' ? got.suggestion : null
      }
    })

    return { kind: 'graded', criteria: out }
  } catch (err) {
    if (!(err instanceof AiError)) throw err
    return { kind: 'failed', errorKind: err.kind, retryAfter: err.retryAfter }
  }
}
