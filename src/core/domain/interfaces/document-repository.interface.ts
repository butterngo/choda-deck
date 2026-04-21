import type {
  Document,
  DocumentType,
  CreateDocumentInput,
  UpdateDocumentInput
} from '../task-types'

export interface DocumentOperations {
  createDocument(input: CreateDocumentInput): Document
  updateDocument(id: string, input: UpdateDocumentInput): Document
  deleteDocument(id: string): void
  getDocument(id: string): Document | null
  findDocuments(projectId: string, type?: DocumentType): Document[]
}
