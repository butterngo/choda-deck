import type {
  CreateInboxInput,
  InboxFilter,
  InboxItem,
  UpdateInboxInput
} from '../task-types'

export interface InboxOperations {
  createInbox(input: CreateInboxInput): Promise<InboxItem>
  updateInbox(id: string, input: UpdateInboxInput): Promise<InboxItem>
  getInbox(id: string): Promise<InboxItem | null>
  findInbox(filter: InboxFilter): Promise<InboxItem[]>
  deleteInbox(id: string): Promise<void>
}
