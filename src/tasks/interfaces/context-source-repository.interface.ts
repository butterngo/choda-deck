import type {
  ContextSource,
  CreateContextSourceInput,
  UpdateContextSourceInput
} from '../task-types'

export interface ContextSourceOperations {
  createContextSource(input: CreateContextSourceInput): ContextSource
  updateContextSource(id: string, input: UpdateContextSourceInput): ContextSource
  getContextSource(id: string): ContextSource | null
  findContextSources(projectId: string, activeOnly?: boolean): ContextSource[]
  deleteContextSource(id: string): void
}
