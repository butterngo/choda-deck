// TASK-2586 / TASK-2595 — an acceptance criterion names how it is meant to be
// proven, as the last token after ` — `: `test`, `command`, `grep` or `human`.
// `ac_check` then records how it WAS proven (`method` + `ref`) and refuses a
// method the tag does not allow. Pure, no DB: the adapter's Runs coverage reuses
// `acTag` and `methodAllowed` so the two never disagree.

export type AcTag = 'test' | 'command' | 'grep' | 'human'
export type AcMethod = 'test' | 'command' | 'grep' | 'manual'

export const AC_METHODS: readonly AcMethod[] = ['test', 'command', 'grep', 'manual']

const TAG_RE = /\s—\s+(test|command|grep|human)\s*$/i

/** The expected check an AC line declares, or null when it declares none. */
export function acTag(line: string): AcTag | null {
  const m = TAG_RE.exec(line)
  return m ? (m[1].toLowerCase() as AcTag) : null
}

const ALLOWED: Record<AcTag, readonly AcMethod[]> = {
  test: ['test'],
  command: ['command', 'test'],
  grep: ['grep', 'command', 'test'],
  human: ['manual']
}

/** Whether `method` may prove an AC tagged `tag`. An untagged AC accepts any method. */
export function methodAllowed(tag: AcTag | null, method: AcMethod | null | undefined): boolean {
  if (tag === null) return true
  return method != null && ALLOWED[tag].includes(method)
}

/** A tagged machine AC must name what proved it; a human AC need not. */
export function refRequired(tag: AcTag | null): boolean {
  return tag === 'test' || tag === 'command' || tag === 'grep'
}

export function allowedMethods(tag: AcTag): readonly AcMethod[] {
  return ALLOWED[tag]
}
