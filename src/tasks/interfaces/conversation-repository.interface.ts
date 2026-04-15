import type {
  Conversation,
  ConversationStatus,
  ConversationMessage,
  ConversationLink,
  ConversationLinkType,
  ConversationParticipant,
  ConversationParticipantType,
  ConversationAction,
  CreateConversationInput,
  UpdateConversationInput,
  CreateConversationMessageInput,
  CreateConversationActionInput,
  UpdateConversationActionInput
} from '../task-types'

export interface ConversationOperations {
  createConversation(input: CreateConversationInput): Conversation
  updateConversation(id: string, input: UpdateConversationInput): Conversation
  getConversation(id: string): Conversation | null
  findConversations(projectId: string, status?: ConversationStatus): Conversation[]
  deleteConversation(id: string): void

  addConversationParticipant(
    conversationId: string,
    name: string,
    type: ConversationParticipantType,
    role?: string | null
  ): void
  removeConversationParticipant(conversationId: string, name: string): void
  getConversationParticipants(conversationId: string): ConversationParticipant[]

  addConversationMessage(input: CreateConversationMessageInput): ConversationMessage
  getConversationMessages(conversationId: string): ConversationMessage[]

  addConversationAction(input: CreateConversationActionInput): ConversationAction
  updateConversationAction(id: string, input: UpdateConversationActionInput): ConversationAction
  getConversationActions(conversationId: string): ConversationAction[]

  linkConversation(conversationId: string, linkedType: ConversationLinkType, linkedId: string): void
  unlinkConversation(conversationId: string, linkedType: ConversationLinkType, linkedId: string): void
  getConversationLinks(conversationId: string): ConversationLink[]
  findConversationsByLink(linkedType: ConversationLinkType, linkedId: string): Conversation[]
}
