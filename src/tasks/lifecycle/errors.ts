export class LifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'LifecycleError'
  }
}

export class InboxNotFoundError extends LifecycleError {
  constructor(id: string) {
    super('INBOX_NOT_FOUND', `Inbox ${id} not found`)
    this.name = 'InboxNotFoundError'
  }
}

export class InboxStatusError extends LifecycleError {
  constructor(id: string, current: string, message: string) {
    super('INBOX_INVALID_STATUS', `Inbox ${id} is ${current} — ${message}`)
    this.name = 'InboxStatusError'
  }
}

export class InboxConflictError extends LifecycleError {
  constructor(id: string, message: string) {
    super('INBOX_CONFLICT', `Inbox ${id}: ${message}`)
    this.name = 'InboxConflictError'
  }
}

export class ConversationNotFoundError extends LifecycleError {
  constructor(id: string) {
    super('CONVERSATION_NOT_FOUND', `Conversation ${id} not found`)
    this.name = 'ConversationNotFoundError'
  }
}

export class ConversationStatusError extends LifecycleError {
  constructor(id: string, current: string, message: string) {
    super('CONVERSATION_INVALID_STATUS', `Conversation ${id} is ${current} — ${message}`)
    this.name = 'ConversationStatusError'
  }
}

export class ConversationConflictError extends LifecycleError {
  constructor(message: string) {
    super('CONVERSATION_CONFLICT', message)
    this.name = 'ConversationConflictError'
  }
}
