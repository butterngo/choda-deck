import type {
  ContextSource,
  CreateContextSourceInput,
  UpdateContextSourceInput
} from '../task-types'

export interface ContextSourceOperations {
  createContextSource(input: CreateContextSourceInput): Promise<ContextSource>
  updateContextSource(id: string, input: UpdateContextSourceInput): Promise<ContextSource>
  getContextSource(id: string): Promise<ContextSource | null>
  findContextSources(projectId: string, activeOnly?: boolean): Promise<ContextSource[]>
  deleteContextSource(id: string): Promise<void>
}
