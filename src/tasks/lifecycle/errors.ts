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

export class SessionNotFoundError extends LifecycleError {
  constructor(id: string) {
    super('SESSION_NOT_FOUND', `Session ${id} not found`)
    this.name = 'SessionNotFoundError'
  }
}

export class SessionStatusError extends LifecycleError {
  constructor(id: string, current: string, message: string) {
    super('SESSION_INVALID_STATUS', `Session ${id} is ${current} — ${message}`)
    this.name = 'SessionStatusError'
  }
}

export interface PipelineActiveBlockingPayload {
  owner_type: 'pipeline'
  owner_session_id: string
  owner_task_id: string | null
  stage: 'plan' | 'generate' | 'evaluate'
  started_at: string
}

export class PipelineActiveBlockingError extends LifecycleError {
  constructor(public readonly payload: PipelineActiveBlockingPayload) {
    super(
      'PIPELINE_ACTIVE_BLOCKING',
      `Active pipeline on session ${payload.owner_session_id} (stage=${payload.stage}) blocks interactive conversation`
    )
    this.name = 'PipelineActiveBlockingError'
  }
}
