import type {
  Task,
  Phase,
  Feature,
  Document,
  Relationship,
  TaskDependency,
  CreateTaskInput,
  UpdateTaskInput,
  TaskFilter,
  CreatePhaseInput,
  UpdatePhaseInput,
  CreateFeatureInput,
  UpdateFeatureInput,
  CreateDocumentInput,
  UpdateDocumentInput,
  RelationType,
  DocumentType,
  DerivedProgress
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

  // Phase CRUD
  createPhase(input: CreatePhaseInput): Phase
  updatePhase(id: string, input: UpdatePhaseInput): Phase
  deletePhase(id: string): void
  getPhase(id: string): Phase | null
  findPhases(projectId: string): Phase[]
  getPhaseProgress(phaseId: string): DerivedProgress

  // Feature CRUD
  createFeature(input: CreateFeatureInput): Feature
  updateFeature(id: string, input: UpdateFeatureInput): Feature
  deleteFeature(id: string): void
  getFeature(id: string): Feature | null
  findFeatures(projectId: string): Feature[]
  findFeaturesByPhase(phaseId: string): Feature[]
  getFeatureProgress(featureId: string): DerivedProgress

  // Document CRUD
  createDocument(input: CreateDocumentInput): Document
  updateDocument(id: string, input: UpdateDocumentInput): Document
  deleteDocument(id: string): void
  getDocument(id: string): Document | null
  findDocuments(projectId: string, type?: DocumentType): Document[]

  // Tags
  addTag(itemId: string, tag: string): void
  removeTag(itemId: string, tag: string): void
  getTags(itemId: string): string[]
  findByTag(tag: string): string[]

  // Relationships
  addRelationship(fromId: string, toId: string, type: RelationType): void
  removeRelationship(fromId: string, toId: string, type: RelationType): void
  getRelationships(itemId: string): Relationship[]
  getRelationshipsFrom(itemId: string, type?: RelationType): Relationship[]

  // Dependencies (legacy compat)
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
