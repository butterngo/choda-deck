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
