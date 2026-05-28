import type {
  Conversation,
  ConversationStatus,
  ConversationMessage,
  ConversationLink,
  ConversationLinkType,
  ConversationParticipant,
  ConversationAction,
  CreateConversationInput,
  UpdateConversationInput,
  CreateConversationMessageInput,
  CreateConversationActionInput,
  UpdateConversationActionInput
} from '../task-types'

export interface ConversationOperations {
  createConversation(input: CreateConversationInput): Promise<Conversation>
  updateConversation(id: string, input: UpdateConversationInput): Promise<Conversation>
  getConversation(id: string): Promise<Conversation | null>
  findConversations(projectId: string, status?: ConversationStatus): Promise<Conversation[]>
  deleteConversation(id: string): Promise<void>

  addConversationParticipant(conversationId: string, name: string): Promise<void>
  removeConversationParticipant(conversationId: string, name: string): Promise<void>
  getConversationParticipants(conversationId: string): Promise<ConversationParticipant[]>

  addConversationMessage(input: CreateConversationMessageInput): Promise<ConversationMessage>
  getConversationMessages(conversationId: string): Promise<ConversationMessage[]>
  markConversationMessageRead(messageId: string, participantName: string): Promise<void>

  addConversationAction(input: CreateConversationActionInput): Promise<ConversationAction>
  updateConversationAction(id: string, input: UpdateConversationActionInput): Promise<ConversationAction>
  getConversationActions(conversationId: string): Promise<ConversationAction[]>

  linkConversation(conversationId: string, linkedType: ConversationLinkType, linkedId: string): Promise<void>
  unlinkConversation(
    conversationId: string,
    linkedType: ConversationLinkType,
    linkedId: string
  ): Promise<void>
  getConversationLinks(conversationId: string): Promise<ConversationLink[]>
  findConversationsByLink(linkedType: ConversationLinkType, linkedId: string): Promise<Conversation[]>
}
