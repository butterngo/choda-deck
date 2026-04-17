import type {
  CreateInboxInput,
  InboxFilter,
  InboxItem,
  UpdateInboxInput
} from '../task-types'

export interface InboxOperations {
  createInbox(input: CreateInboxInput): InboxItem
  updateInbox(id: string, input: UpdateInboxInput): InboxItem
  getInbox(id: string): InboxItem | null
  findInbox(filter: InboxFilter): InboxItem[]
  deleteInbox(id: string): void
}
