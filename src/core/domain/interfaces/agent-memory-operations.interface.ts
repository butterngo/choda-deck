import type { AgentMemory, MemoryScopeType, MemoryType } from '../task-types'

export interface MemoryWriteInput {
  scopeType: MemoryScopeType
  scopeId: string
  memoryType: MemoryType
  content: string
  tags?: string[]
  importance?: number
  sourceSessionId?: string
  sourceEventIds?: string[]
}

export interface MemoryRecallInput {
  taskId?: string
  workspaceId?: string
  projectId?: string
  userId?: string
  tags?: string[]
  limit?: number
}

export interface AgentMemoryOperations {
  writeMemory(input: MemoryWriteInput): AgentMemory
  recallMemories(input: MemoryRecallInput): AgentMemory[]
  markMemoryPromoted(memoryId: string, adrSlug: string): void
}
