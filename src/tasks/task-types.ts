// Task management types — pure types, zero runtime dependencies

export type TaskStatus = 'TODO' | 'READY' | 'IN-PROGRESS' | 'DONE'
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low'

export const TASK_STATUSES: TaskStatus[] = ['TODO', 'READY', 'IN-PROGRESS', 'DONE']

export interface Project {
  id: string
  name: string
  cwd: string
}

export interface Epic {
  id: string
  projectId: string
  title: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
}

export interface Task {
  id: string
  projectId: string
  epicId: string | null
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
  epicId?: string
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
  epicId?: string | null
  parentTaskId?: string | null
  labels?: string[]
  dueDate?: string | null
  pinned?: boolean
}

export interface TaskFilter {
  projectId?: string
  status?: TaskStatus
  priority?: TaskPriority
  epicId?: string
  parentTaskId?: string
  pinned?: boolean
  dueBefore?: string
  query?: string
  limit?: number
}

export interface CreateEpicInput {
  id?: string
  projectId: string
  title: string
  status?: TaskStatus
}

export interface UpdateEpicInput {
  title?: string
  status?: TaskStatus
}
