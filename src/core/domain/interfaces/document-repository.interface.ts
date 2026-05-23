import type {
  Document,
  DocumentType,
  CreateDocumentInput,
  UpdateDocumentInput
} from '../task-types'

export interface DocumentOperations {
  createDocument(input: CreateDocumentInput): Promise<Document>
  updateDocument(id: string, input: UpdateDocumentInput): Promise<Document>
  deleteDocument(id: string): Promise<void>
  getDocument(id: string): Promise<Document | null>
  findDocuments(projectId: string, type?: DocumentType): Promise<Document[]>
}
