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

export class ConversationAddSchemaError extends LifecycleError {
  constructor(message: string) {
    super('CONVERSATION_ADD_SCHEMA', message)
    this.name = 'ConversationAddSchemaError'
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

export class TaskNotFoundError extends LifecycleError {
  constructor(id: string) {
    super('TASK_NOT_FOUND', `Task ${id} not found`)
    this.name = 'TaskNotFoundError'
  }
}

export class TaskStatusError extends LifecycleError {
  constructor(id: string, current: string, message: string) {
    super('TASK_INVALID_STATUS', `Task ${id} is ${current} — ${message}`)
    this.name = 'TaskStatusError'
  }
}

export class TaskLockedBySessionError extends LifecycleError {
  constructor(taskId: string, sessionId: string) {
    super(
      'TASK_LOCKED_BY_SESSION',
      `Task ${taskId} is already linked to active session ${sessionId} — end that session first`
    )
    this.name = 'TaskLockedBySessionError'
  }
}

export class WorkspaceResolutionError extends LifecycleError {
  constructor(message: string) {
    super('WORKSPACE_RESOLUTION_FAILED', message)
    this.name = 'WorkspaceResolutionError'
  }
}

export class AcIndexOutOfRangeError extends LifecycleError {
  constructor(taskId: string, index: number, total: number) {
    super(
      'AC_INDEX_OUT_OF_RANGE',
      `Task ${taskId} has ${total} AC items — index ${index} is out of range (valid: 0..${total - 1})`
    )
    this.name = 'AcIndexOutOfRangeError'
  }
}

export class AcAlreadyCheckedError extends LifecycleError {
  constructor(taskId: string, index: number) {
    super('AC_ALREADY_CHECKED', `Task ${taskId} AC[${index}] is already checked`)
    this.name = 'AcAlreadyCheckedError'
  }
}

export class BodyLockViolationError extends LifecycleError {
  constructor(taskId: string, detail: string) {
    super(
      'BODY_LOCK_VIOLATION',
      `Task ${taskId}: ac_check tried to mutate body outside the single AC checkbox — ${detail}`
    )
    this.name = 'BodyLockViolationError'
  }
}

export class NoActiveSessionError extends LifecycleError {
  constructor(projectId: string, workspaceId: string | null) {
    const scope = workspaceId ? `workspace ${workspaceId}` : `project ${projectId}`
    super(
      'NO_ACTIVE_SESSION',
      `No active session for ${scope} — start one with session_start before calling ac_check`
    )
    this.name = 'NoActiveSessionError'
  }
}

export class QueueDirtyTreeError extends LifecycleError {
  constructor(cwd: string, porcelain: string) {
    super(
      'QUEUE_DIRTY_TREE',
      `Queue refuses to start: working tree at ${cwd} is dirty. Commit or stash first.\n${porcelain.trim()}`
    )
    this.name = 'QueueDirtyTreeError'
  }
}
