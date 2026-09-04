// TASK-1842 — deterministic checks over a config file, DECLARED rather than
// branched on.
//
// ## Why a registry and not a switch
//
// `handler-config-validation-is-declared-never-special-cased` (bpa-engine)
// records what the alternative costs. Rule metadata once lived in two arrays
// with behaviour in a `switch`, nothing made the three agree, and a type present
// in the arrays but missing from the switch saved happily and then denied every
// move. Its rule — *never branch on the type in a save path* — is the same rule
// here wearing `rootId`.
//
// A validator shaped as `if (rootId === 'skills')` is that drift arriving
// through a different door, and it quietly makes "adding a check is adding a
// file" false the moment somebody believes it. So a check is a DECLARATION —
// which files it applies to, and what it asserts — and one runner applies every
// declaration without knowing what any of them mean.
//
// ## Why both directions
//
// The same entry's second half: a mapping is checked BOTH ways, because the two
// directions catch different failures. Applied to the registry drift this
// design was taken from:
//
//   renderer keys ⊆ registry — LOUD: a template renders with no schema. This is
//     the drift that actually happened; `table-4` was missing for a month.
//   registry ⊆ renderer keys — QUIET: a schema nothing renders. Never checked
//     there, and it is the direction that lets a catalog claim 57 when 56 exist.
//
// `compareKeySets` exists so a declaration gets both for free and cannot report
// only the loud one. Its first production consumer is the template registry
// (TASK-1384's domain, in another repo) — here it ships as the primitive that
// case needs, exercised through the registration surface.
//
// ## What is deliberately NOT here
//
// No model call, no key read, no network. Validation has to work on a machine
// that never configured a provider — a validator that degrades to nothing during
// an outage is one nobody can rely on. Judgement about prose is TASK-1843's
// route, behind its own door so it cannot be reached by accident.

export type Severity = 'error' | 'warning' | 'note'

export interface Finding {
  checkId: string
  severity: Severity
  message: string
  /** 1-based, or null when the finding is about the file rather than a line. */
  line: number | null
}

export interface CheckContext {
  rootId: string
  /** Forward-slashed, relative to the root. */
  rel: string
  /** Absolute path, for messages only. */
  path: string
  /** The bytes as they are on disk, or as submitted. Never normalised. */
  bytes: Buffer
  /** The same content decoded as utf8, for checks that read text. */
  text: string
}

export interface CheckDeclaration {
  id: string
  /** True when this check has an opinion about the file in ctx. */
  appliesTo(ctx: CheckContext): boolean
  run(ctx: CheckContext): Finding[]
}

const REGISTRY = new Map<string, CheckDeclaration>()

/**
 * Register a check. Returns the function that removes it again.
 *
 * The unregister half is not a convenience: a test that registers a declaration
 * and cannot remove it leaks into every later test in the file, and the leak
 * looks like a flaky assertion somewhere else entirely.
 */
export function registerCheck(decl: CheckDeclaration): () => void {
  REGISTRY.set(decl.id, decl)
  return () => {
    REGISTRY.delete(decl.id)
  }
}

/** Every registered check that applies, in registration order. */
export function runChecks(ctx: CheckContext): Finding[] {
  const out: Finding[] = []
  for (const decl of REGISTRY.values()) {
    // A check that throws must not take the whole validation down — one broken
    // declaration would otherwise silence every other check on the file.
    try {
      if (decl.appliesTo(ctx)) out.push(...decl.run(ctx))
    } catch (err) {
      out.push({
        checkId: decl.id,
        severity: 'error',
        message: `check failed: ${err instanceof Error ? err.message : String(err)}`,
        line: null
      })
    }
  }
  return out
}

/**
 * Two key sets, compared BOTH ways, each direction under its own checkId.
 *
 * Distinct ids are the point: one id for both directions makes the quiet
 * failure indistinguishable from the loud one in the response, which is exactly
 * how a reader learns to see only half of a drift.
 */
export function compareKeySets(
  left: Iterable<string>,
  right: Iterable<string>,
  ids: { onlyInLeft: string; onlyInRight: string },
  describe: { onlyInLeft: (key: string) => string; onlyInRight: (key: string) => string },
  severity: Severity = 'warning'
): Finding[] {
  const l = new Set(left)
  const r = new Set(right)
  const out: Finding[] = []
  for (const key of l) {
    if (!r.has(key)) {
      out.push({ checkId: ids.onlyInLeft, severity, message: describe.onlyInLeft(key), line: null })
    }
  }
  for (const key of r) {
    if (!l.has(key)) {
      out.push({ checkId: ids.onlyInRight, severity, message: describe.onlyInRight(key), line: null })
    }
  }
  return out
}

/**
 * Frontmatter reader that understands FOLDED scalars.
 *
 * Lives here rather than in claude-config.ts so the import runs one way only —
 * claude-config imports the checks, never the reverse. It is re-exported there
 * for the callers that already had it.
 *
 * vault.ts exports a parseFrontmatter and reusing it was the first plan. That
 * one reads flat `key: value` only, and 11 of the 13 skills on this machine
 * write `description: >` with the text on following indented lines — reuse would
 * have left most of the inventory blank while every test on inline fixtures
 * stayed green.
 */
export function parseSkillFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}

  const lines = text.slice(3, end).split('\n')
  const out: Record<string, string> = {}
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (/^\s/.test(line) || line.indexOf(':') <= 0) {
      i++
      continue
    }
    const at = line.indexOf(':')
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    i++

    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts: string[] = []
      while (i < lines.length && (/^\s+\S/.test(lines[i]) || lines[i].trim() === '')) {
        const trimmed = lines[i].trim()
        if (trimmed.length > 0) parts.push(trimmed)
        i++
      }
      value = parts.join(' ')
    }

    if (key.length > 0) out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// The checks that ship by default. Each one is a declaration like any other —
// nothing in the runner knows they exist.
// ---------------------------------------------------------------------------

/**
 * A UTF-8 BOM is REPORTED, never removed.
 *
 * template-registry.json carries one and it has already broken JSON.parse in
 * production, taking two MCP tools down while a third kept working. Stripping it
 * during a save would silently fix a bug in a file somebody opened for an
 * unrelated reason — an unrequested change, blamed on whatever else they edited.
 * Reporting it is the difference between a validator and a formatter.
 */
registerCheck({
  id: 'utf8-bom',
  appliesTo: () => true,
  run: (ctx) =>
    ctx.bytes.length >= 3 && ctx.bytes[0] === 0xef && ctx.bytes[1] === 0xbb && ctx.bytes[2] === 0xbf
      ? [
          {
            checkId: 'utf8-bom',
            severity: 'warning',
            message:
              'This file begins with a UTF-8 BOM. JSON.parse rejects it, and a reader that strips it silently changes a file nobody asked to change.',
            line: 1
          }
        ]
      : []
})

/**
 * A skill's description is what decides whether it is ever loaded, so an absent
 * one is a skill that exists and never triggers.
 */
registerCheck({
  id: 'skill-frontmatter',
  appliesTo: (ctx) => ctx.rel.toLowerCase().endsWith('skill.md'),
  run: (ctx) => {
    const fm = parseSkillFrontmatter(ctx.text)
    const out: Finding[] = []
    if (!fm.name || fm.name.length === 0) {
      out.push({
        checkId: 'skill-frontmatter',
        severity: 'error',
        message: 'Frontmatter has no `name`; the skill falls back to its directory name.',
        line: 1
      })
    }
    if (!fm.description || fm.description.length === 0) {
      out.push({
        checkId: 'skill-frontmatter',
        severity: 'error',
        message:
          'Frontmatter has no `description`. The description is what decides when a skill is loaded — without one it exists and never triggers.',
        line: 1
      })
    }
    return out
  }
})
