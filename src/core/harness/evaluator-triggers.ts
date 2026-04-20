// Per ADR-014 Q2: when Butter selects evaluator='auto', enable Evaluator iff the
// task title or any AC contains one of these keywords. List is data, not architecture
// — additions/removals do not require an ADR revision.

export const EVALUATOR_TRIGGER_KEYWORDS: readonly string[] = [
  'security',
  'auth',
  'authentication',
  'authorization',
  'migration',
  'schema',
  'database',
  'payment',
  'billing',
  'permission',
  'access control'
]

export function shouldEnableEvaluator(
  taskTitle: string,
  acceptanceCriteria: readonly string[]
): boolean {
  const haystack = [taskTitle, ...acceptanceCriteria].join('\n').toLowerCase()
  return EVALUATOR_TRIGGER_KEYWORDS.some((kw) => haystack.includes(kw))
}
