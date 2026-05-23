import type {
  Task,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilter,
  TaskDependency
} from '../task-types'

export interface TaskOperations {
  createTask(input: CreateTaskInput): Promise<Task>
  updateTask(id: string, input: UpdateTaskInput): Promise<Task>
  deleteTask(id: string): Promise<void>
  getTask(id: string): Promise<Task | null>
  findTasks(filter: TaskFilter): Promise<Task[]>
  getSubtasks(parentId: string): Promise<Task[]>
  getPinnedTasks(): Promise<Task[]>
  getDueTasks(date: string): Promise<Task[]>
  addDependency(sourceId: string, targetId: string): Promise<void>
  removeDependency(sourceId: string, targetId: string): Promise<void>
  getDependencies(taskId: string): Promise<TaskDependency[]>
}
