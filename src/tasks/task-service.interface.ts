import type {
  Task,
  Epic,
  TaskDependency,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilter,
  CreateEpicInput,
  UpdateEpicInput
} from './task-types'

export interface TaskService {
  // Task CRUD
  createTask(input: CreateTaskInput): Task
  updateTask(id: string, input: UpdateTaskInput): Task
  deleteTask(id: string): void
  getTask(id: string): Task | null
  findTasks(filter: TaskFilter): Task[]

  // Subtasks
  getSubtasks(parentId: string): Task[]

  // Epic CRUD
  createEpic(input: CreateEpicInput): Epic
  updateEpic(id: string, input: UpdateEpicInput): Epic
  deleteEpic(id: string): void
  getEpic(id: string): Epic | null
  findEpics(projectId: string): Epic[]
  getEpicProgress(epicId: string): { total: number; done: number }

  // Dependencies
  addDependency(sourceId: string, targetId: string): void
  removeDependency(sourceId: string, targetId: string): void
  getDependencies(taskId: string): TaskDependency[]

  // Daily focus
  getPinnedTasks(): Task[]
  getDueTasks(date: string): Task[]

  // Lifecycle
  initialize(): void
  close(): void
}
