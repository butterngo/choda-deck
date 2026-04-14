// Task management types — pure types, zero runtime dependencies

export type TaskStatus = 'TODO' | 'READY' | 'IN-PROGRESS' | 'DONE'
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low'
export type PhaseStatus = 'open' | 'closed'
export type DerivedStatus = 'planned' | 'active' | 'completed'
export type RelationType = 'DEPENDS_ON' | 'IMPLEMENTS' | 'USES_TECH' | 'DECIDED_BY'
export type DocumentType = 'adr' | 'guide' | 'spec' | 'note' | 'research'

export const TASK_STATUSES: TaskStatus[] = ['TODO', 'READY', 'IN-PROGRESS', 'DONE']

export interface Project {
  id: string
  name: string
  cwd: string
}

export interface Phase {
  id: string
  projectId: string
  title: string
  status: PhaseStatus
  position: number
  targetDate: string | null
  createdAt: string
  updatedAt: string
}

export interface Feature {
  id: string
  projectId: string
  phaseId: string | null
  title: string
  priority: TaskPriority | null
  createdAt: string
  updatedAt: string
}

export interface Document {
  id: string
  projectId: string
  type: DocumentType
  title: string
  filePath: string | null
  createdAt: string
  updatedAt: string
}

export interface Tag {
  itemId: string
  tag: string
}

export interface Relationship {
  fromId: string
  toId: string
  type: RelationType
}

export interface Task {
  id: string
  projectId: string
  featureId: string | null
  parentTaskId: string | null
  title: string
  status: TaskStatus
  priority: TaskPriority | null
  labels: string[]
  dueDate: string | null
  pinned: boolean
  filePath: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskDependency {
  sourceId: string
  targetId: string
}

export interface CreateTaskInput {
  id?: string
  projectId: string
  featureId?: string
  parentTaskId?: string
  title: string
  status?: TaskStatus
  priority?: TaskPriority
  labels?: string[]
  dueDate?: string
  filePath?: string
}

export interface UpdateTaskInput {
  title?: string
  status?: TaskStatus
  priority?: TaskPriority | null
  featureId?: string | null
  parentTaskId?: string | null
  labels?: string[]
  dueDate?: string | null
  pinned?: boolean
}

export interface TaskFilter {
  projectId?: string
  status?: TaskStatus
  priority?: TaskPriority
  featureId?: string
  parentTaskId?: string
  pinned?: boolean
  dueBefore?: string
  query?: string
  limit?: number
}

export interface CreatePhaseInput {
  id?: string
  projectId: string
  title: string
  status?: PhaseStatus
  position?: number
  targetDate?: string
}

export interface UpdatePhaseInput {
  title?: string
  status?: PhaseStatus
  position?: number
  targetDate?: string | null
}

export interface CreateFeatureInput {
  id?: string
  projectId: string
  phaseId?: string
  title: string
  priority?: TaskPriority
}

export interface UpdateFeatureInput {
  title?: string
  phaseId?: string | null
  priority?: TaskPriority | null
}

export interface CreateDocumentInput {
  id?: string
  projectId: string
  type: DocumentType
  title: string
  filePath?: string
}

export interface UpdateDocumentInput {
  title?: string
  type?: DocumentType
  filePath?: string | null
}

export interface DerivedProgress {
  total: number
  done: number
  inProgress: number
  status: DerivedStatus
  percent: number
}
