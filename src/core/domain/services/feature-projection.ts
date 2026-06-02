import type { EffortBand, FeatureStatus } from '../knowledge-types'
import type { TouchesRelation } from '../code-ref-types'

// ADR-NNN Pillar 5 — read-time role projection (TASK-994). Pure functions only:
// the builder (feature-projection-builder.ts) does the I/O and feeds gathered
// graph data in here; this module decides which slices each role sees and runs
// the deterministic guards that make role bleed (M3) and effort-band leakage
// (M4) structurally impossible. No DB, no fs — fully unit-testable.

export type ProjectionRole = 'ceo-po' | 'dev' | 'tester'

export const PROJECTION_ROLES: readonly ProjectionRole[] = ['ceo-po', 'dev', 'tester']

// A gotcha surfaced via the ABOUT edge. CEO sees title only (business voice);
// dev sees the full structured fields (symbols/SQL allowed); tester derives
// edge cases from `trigger` + `context` (TASK-995).
export interface GotchaSummary {
  slug: string
  title: string
  trigger?: string
  context?: string
  resolution?: string
}

// One realized task's acceptance criteria, collated for the tester view
// (REALIZES edge → getTask → findAcItems). Tester-only.
export interface RealizedTaskAc {
  taskId: string
  title: string
  status: string
  acItems: string[]
}

// A code anchor resolved through REALIZES → TOUCHES → code_ref, carrying the
// load-bearing relation (B1 finding). Dev-only.
export interface CodeRefPointer {
  taskId: string
  slug: string
  path: string
  symbol: string | null
  relation: TouchesRelation
}

// Raw graph slice the builder gathers once, then hands to projectFeature().
export interface FeatureProjectionInput {
  featureId: string
  title: string
  status?: FeatureStatus
  effortBand?: EffortBand
  // `## heading` (lowercased, trimmed) → section body text.
  sections: Record<string, string>
  workspaces: string[] // IN edges
  realizesTaskIds: string[] // REALIZES edges
  gotchas: GotchaSummary[] // ABOUT edges (computed once, sliced per role)
  codeRefs: CodeRefPointer[] // dev only: REALIZES → TOUCHES → code_ref
  realizesTasksHaveTouches: boolean // true if any REALIZES task has ≥1 TOUCHES edge
  realizesTasks: RealizedTaskAc[] // tester only: REALIZES → task AC, collated
  isStale: boolean
}

export interface CeoView {
  description: string | null
  apps: string[]
  teams: null // never in the graph — honest gap, never fabricated
  effortBand: EffortBand | null // band letter ONLY, never a number-of-days (M4)
  status: FeatureStatus | null
  blockers: Array<{ slug: string; title: string }> // titles only — no symbol bleed
}

export interface DevView {
  module: string | null
  codeRefs: CodeRefPointer[]
  gotchas: GotchaSummary[]
  relevantDecisions: string[] // gotcha slugs that constrain the approach
  breakingChangeNote: string | null
}

export interface TesterView {
  // AC from each realized task, collated + attributed (not a flat dump).
  acceptanceCriteria: RealizedTaskAc[]
  // One tester-actionable line per gotcha, derived from trigger + context.
  edgeCases: string[]
  // Titles of realized tasks already shipped (status DONE) — regression surface
  // a tester must verify still works.
  regressionScope: string[]
}

export interface Honesty {
  used: string[]
  lacked: string[]
}

// answeredSlices keys map 1:1 to the B4 replay questions for M1 scoring.
export type SliceAnswer = 'yes' | 'partial' | 'no'

export interface FeatureProjectionBundle {
  featureId: string
  role: ProjectionRole
  view: CeoView | DevView | TesterView
  recall: GotchaSummary[] // gotchas surfaced BEFORE the first question (M2)
  honesty: Honesty
}

export class RoleBleedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoleBleedError'
  }
}

// M4: a digit followed by a time unit (optionally a range like 5-7h). MUST NOT
// trip on the band letter `L` or task IDs like `TASK-914` (no unit follows the
// digits). MUST catch `~5–7h`, `3h`, `3 days`, `multi-week`→no (no digit).
const DAY_NUMBER_RE = /\b\d+(?:\s*[-–]\s*\d+)?\s*(?:d|days?|hrs?|hours?|h|wks?|weeks?)\b/i

// M3 (CEO): code bleed — file paths, dotted Namespace.Class.Method symbols, SQL.
const FILE_PATH_RE = /\b[\w/\\.-]+\.(?:cs|ts|tsx|js|mjs|sql|md)\b/i
const DOTTED_SYMBOL_RE = /\b[A-Z][A-Za-z0-9]+(?:\.[A-Z][A-Za-z0-9]+){2,}\b/
const SQL_RE = /\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|jsonb)\b/

// M3 (tester): a DEPLOYMENT date — an ISO date adjacent (within a short window,
// either order) to a deploy/ship/release verb. This is the CEO/PO release-tracking
// dimension; it must not leak into a behavioral tester answer. Deliberately
// narrow: a bare diagnostic date ("data inspection on dev DB (2026-05-22)") is
// legitimate technical context a tester needs, NOT a deployment date, so it
// passes. Task IDs (TASK-917) and bare years never match (no full YYYY-MM-DD).
const DEPLOY_VERB = 'deploy(?:ed|ment)?|releas(?:e|ed|es)|ship(?:ped|s)?|rollout|roll(?:ed)? ?out|launch(?:ed)?|go[- ]?live'
const ISO_DATE = '\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2})?'
const DEPLOY_DATE_RE = new RegExp(
  `(?:\\b(?:${DEPLOY_VERB})\\b[^.\\n]{0,30}?${ISO_DATE})|(?:${ISO_DATE}[^.\\n]{0,20}?\\b(?:${DEPLOY_VERB})\\b)`,
  'i'
)

export function assertNoNumberOfDays(label: string, ...texts: Array<string | null>): void {
  for (const text of texts) {
    if (!text) continue
    const m = text.match(DAY_NUMBER_RE)
    if (m) {
      throw new RoleBleedError(
        `${label}: effort-band fidelity violation (M4) — found time quantity "${m[0]}"`
      )
    }
  }
}

export function assertNoCodeBleed(label: string, ...texts: Array<string | null>): void {
  for (const text of texts) {
    if (!text) continue
    const path = text.match(FILE_PATH_RE)
    if (path) throw new RoleBleedError(`${label}: role bleed (M3) — file path "${path[0]}"`)
    const sym = text.match(DOTTED_SYMBOL_RE)
    if (sym) throw new RoleBleedError(`${label}: role bleed (M3) — dotted symbol "${sym[0]}"`)
    const sql = text.match(SQL_RE)
    if (sql) throw new RoleBleedError(`${label}: role bleed (M3) — SQL token "${sql[0]}"`)
  }
}

// M3 (dev): a dev answer for a feature whose tasks edit code must carry the
// pointers. Empty code_refs when TOUCHES edges exist is a missing-evidence bleed.
export function assertHasCodeRefs(label: string, view: DevView, expectRefs: boolean): void {
  if (expectRefs && view.codeRefs.length === 0) {
    throw new RoleBleedError(
      `${label}: role bleed (M3) — dev answer missing code_refs though REALIZES tasks TOUCH code`
    )
  }
}

// M3 (tester): a tester answer is behavioral — no dotted Namespace.Class.Method
// symbols. File paths are allowed (a tester needs to know which areas to exercise),
// so this is narrower than assertNoCodeBleed by design (TASK-995 AC #5).
export function assertNoSymbolBleed(label: string, ...texts: Array<string | null>): void {
  for (const text of texts) {
    if (!text) continue
    const sym = text.match(DOTTED_SYMBOL_RE)
    if (sym) throw new RoleBleedError(`${label}: role bleed (M3) — dotted symbol "${sym[0]}"`)
  }
}

// M3 (tester): no deployment/release date leaks into a behavioral answer.
export function assertNoDeploymentDate(label: string, ...texts: Array<string | null>): void {
  for (const text of texts) {
    if (!text) continue
    const m = text.match(DEPLOY_DATE_RE)
    if (m) {
      throw new RoleBleedError(`${label}: role bleed (M3) — deployment date "${m[0]}"`)
    }
  }
}

function sectionFor(input: FeatureProjectionInput, ...names: string[]): string | null {
  for (const name of names) {
    const text = input.sections[name]
    if (text && text.trim().length > 0) return text.trim()
  }
  return null
}

function projectCeo(input: FeatureProjectionInput): CeoView {
  return {
    description: sectionFor(input, 'description'),
    apps: input.workspaces,
    teams: null,
    effortBand: input.effortBand ?? null,
    status: input.status ?? null,
    // Titles only: gotcha bodies carry symbols/SQL and would bleed into the
    // CEO voice. The agent verbalizes business prose from these clean slices.
    blockers: input.gotchas.map((g) => ({ slug: g.slug, title: g.title }))
  }
}

function projectDev(input: FeatureProjectionInput): DevView {
  const blocking = sectionFor(input, 'currently blocking')
  const status = input.status ?? null
  return {
    module: sectionFor(input, 'description'),
    codeRefs: input.codeRefs,
    gotchas: input.gotchas,
    relevantDecisions: input.gotchas.map((g) => g.slug),
    breakingChangeNote:
      status === 'blocked' && blocking ? `Feature is blocked: ${blocking}` : blocking
  }
}

// Derive one tester-actionable edge case per gotcha from its trigger + context.
// Falls back gracefully when either field is absent so any gotcha yields a line
// (AC #1: useful answer for any feature with ≥1 gotcha).
function deriveEdgeCase(g: GotchaSummary): string {
  const detail = [g.trigger, g.context].filter((s) => s && s.trim().length > 0).join(' — ')
  return detail ? `${g.title}: ${detail}` : g.title
}

function projectTester(input: FeatureProjectionInput): TesterView {
  return {
    acceptanceCriteria: input.realizesTasks,
    edgeCases: input.gotchas.map(deriveEdgeCase),
    regressionScope: input.realizesTasks
      .filter((t) => t.status === 'DONE')
      .map((t) => t.title)
  }
}

function computeHonesty(input: FeatureProjectionInput, role: ProjectionRole): Honesty {
  const used: string[] = []
  const lacked: string[] = []

  if (sectionFor(input, 'description')) used.push('description')
  if (input.workspaces.length > 0) used.push('workspaces')
  else lacked.push('workspaces')
  if (input.gotchas.length > 0) used.push('gotchas')
  else lacked.push('recall')

  // Team boundaries are never recorded in the graph — surface the gap, never
  // fabricate (matches pilot Q2 honest-failure).
  lacked.push('team-boundaries')

  if (role === 'ceo-po') {
    if (input.effortBand) used.push('effort-band')
    else lacked.push('effort-band')
  }

  if (role === 'dev') {
    if (input.codeRefs.length > 0) used.push('code-refs')
    else if (input.realizesTasksHaveTouches) lacked.push('code-refs')
  }

  if (role === 'tester') {
    if (input.realizesTasks.some((t) => t.acItems.length > 0)) used.push('acceptance-criteria')
    else lacked.push('acceptance-criteria')
    if (input.gotchas.length > 0) used.push('edge-cases')
    else lacked.push('edge-cases')
    if (input.realizesTasks.some((t) => t.status === 'DONE')) used.push('regression-scope')
    else lacked.push('regression-scope')
  }

  if (input.isStale) lacked.push('stale-refs')

  return { used, lacked }
}

export function projectFeature(
  input: FeatureProjectionInput,
  role: ProjectionRole
): FeatureProjectionBundle {
  const honesty = computeHonesty(input, role)

  if (role === 'ceo-po') {
    const view = projectCeo(input)
    assertNoCodeBleed('ceo-po', view.description, ...view.blockers.map((b) => b.title))
    assertNoNumberOfDays('ceo-po', view.description, view.effortBand, ...view.blockers.map((b) => b.title))
    return { featureId: input.featureId, role, view, recall: input.gotchas, honesty }
  }

  if (role === 'tester') {
    const view = projectTester(input)
    // Guard the projection's DERIVED surfaces (edge cases, regression scope, task
    // titles) — these are where dev symbols or release dates would bleed in via
    // our derivation logic. Verbatim AC items are the tester's source material
    // (AC #2/#4): a date or symbol the task author wrote into their own AC is
    // faithful relay, not cross-role bleed, so it passes through untouched.
    const derived = [...view.edgeCases, ...view.regressionScope, ...view.acceptanceCriteria.map((t) => t.title)]
    assertNoSymbolBleed('tester', ...derived)
    assertNoDeploymentDate('tester', ...derived)
    return { featureId: input.featureId, role, view, recall: input.gotchas, honesty }
  }

  const view = projectDev(input)
  assertHasCodeRefs('dev', view, input.realizesTasksHaveTouches)
  return { featureId: input.featureId, role, view, recall: input.gotchas, honesty }
}
