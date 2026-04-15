import type { Task, CreateTaskInput, UpdateTaskInput, TaskFilter, TaskDependency } from '../task-types'

export interface TaskOperations {
  createTask(input: CreateTaskInput): Task
  updateTask(id: string, input: UpdateTaskInput): Task
  deleteTask(id: string): void
  getTask(id: string): Task | null
  findTasks(filter: TaskFilter): Task[]
  getSubtasks(parentId: string): Task[]
  getPinnedTasks(): Task[]
  getDueTasks(date: string): Task[]
  addDependency(sourceId: string, targetId: string): void
  removeDependency(sourceId: string, targetId: string): void
  getDependencies(taskId: string): TaskDependency[]
}
