import { useEffect, useMemo, useState } from 'react'

type InboxStatus = 'raw' | 'researching' | 'ready' | 'converted' | 'archived'

interface InboxItem {
  id: string
  projectId: string | null
  content: string
  status: InboxStatus
  linkedTaskId: string | null
  createdAt: string
  updatedAt: string
}

interface ConversationMessage {
  id: string
  authorName: string
  content: string
  messageType: string
  createdAt: string
}

interface LinkedConversation {
  id: string
  title: string
  status: string
  decisionSummary: string | null
  messages: ConversationMessage[]
}

interface InboxDetail {
  item: InboxItem
  conversations: LinkedConversation[]
}

interface InboxViewProps {
  projectId: string
  visible: boolean
}

const ACTIVE_STATUSES: InboxStatus[] = ['raw', 'researching', 'ready']
const TERMINAL_STATUSES: InboxStatus[] = ['converted', 'archived']
const COLLAPSIBLE_TYPES = new Set(['system', 'tool'])

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })
}

function badgeClass(status: string): string {
  return `deck-badge deck-badge--${status.toLowerCase()}`
}

export default function InboxView({ projectId, visible }: InboxViewProps): React.JSX.Element {
  const [items, setItems] = useState<InboxItem[]>([])
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [showArchived, setShowArchived] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<InboxDetail | null>(null)
  const [converting, setConverting] = useState(false)
  const [convertTitle, setConvertTitle] = useState('')
  const [convertPriority, setConvertPriority] = useState<'critical' | 'high' | 'medium' | 'low'>(
    'medium'
  )
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set())
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setLoading(true)
    const filter: { projectId?: string | null } = {
      projectId: scope === 'global' ? null : projectId
    }
    window.api.inbox
      .list(filter)
      .then((rows) => {
        if (cancelled) return
        setItems(rows as InboxItem[])
        setLoading(false)
      })
      .catch(() => setLoading(false))
    return () => {
      cancelled = true
    }
  }, [projectId, scope, visible, reloadTick])

  const visibleItems = useMemo(() => {
    const allowed = showArchived
      ? new Set<InboxStatus>([...ACTIVE_STATUSES, ...TERMINAL_STATUSES])
      : new Set<InboxStatus>(ACTIVE_STATUSES)
    return items.filter((i) => allowed.has(i.status))
  }, [items, showArchived])

  async function refreshSelected(id: string): Promise<void> {
    const detail = (await window.api.inbox.get(id)) as InboxDetail | null
    if (detail) setSelected(detail)
  }

  async function openDetail(id: string): Promise<void> {
    setEditing(false)
    setConverting(false)
    setExpandedMessages(new Set())
    await refreshSelected(id)
  }

  function closeDetail(): void {
    setSelected(null)
    setEditing(false)
    setConverting(false)
  }

  async function handleArchive(id: string): Promise<void> {
    if (!confirm(`Archive ${id}?`)) return
    await window.api.inbox.archive(id)
    closeDetail()
    setReloadTick((t) => t + 1)
  }

  async function handleDelete(id: string): Promise<void> {
    if (!confirm(`Delete ${id}? (only raw/archived allowed)`)) return
    const res = await window.api.inbox.delete(id)
    if (!res.ok) {
      alert(res.error || 'Delete failed')
      return
    }
    closeDetail()
    setReloadTick((t) => t + 1)
  }

  async function handleResearch(id: string): Promise<void> {
    const res = await window.api.inbox.research(id)
    if (!res.ok) {
      alert(res.error || 'Research failed')
      return
    }
    await refreshSelected(id)
    setReloadTick((t) => t + 1)
  }

  async function handleReady(id: string): Promise<void> {
    const res = await window.api.inbox.ready(id)
    if (!res.ok) {
      alert(res.error || 'Mark ready failed')
      return
    }
    await refreshSelected(id)
    setReloadTick((t) => t + 1)
  }

  async function handleSaveEdit(id: string): Promise<void> {
    const content = editContent.trim()
    if (!content) {
      alert('Content cannot be empty')
      return
    }
    const res = await window.api.inbox.update(id, content)
    if (!res.ok) {
      alert(res.error || 'Update failed')
      return
    }
    setEditing(false)
    await refreshSelected(id)
    setReloadTick((t) => t + 1)
  }

  async function handleConvert(): Promise<void> {
    if (!selected) return
    const title = convertTitle.trim()
    if (!title) {
      alert('Title is required')
      return
    }
    const res = await window.api.inbox.convert(selected.item.id, {
      title,
      priority: convertPriority
    })
    if (!res.ok) {
      alert(res.error || 'Convert failed')
      return
    }
    setConverting(false)
    setConvertTitle('')
    closeDetail()
    setReloadTick((t) => t + 1)
  }

  function toggleMessage(id: string): void {
    setExpandedMessages((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (!visible) return <></>

  return (
    <div className="deck-inbox">
      <div className="deck-inbox-toolbar">
        <div className="deck-inbox-filters">
          <select
            className="deck-inbox-select"
            value={scope}
            onChange={(e) => setScope(e.target.value as 'project' | 'global')}
          >
            <option value="project">Project: {projectId}</option>
            <option value="global">Global (cross-cutting)</option>
          </select>
          <label className="deck-inbox-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        </div>
      </div>

      {loading && <div className="deck-activity-empty">Loading…</div>}

      {!loading && (
        <div className="deck-activity-list">
          {visibleItems.length === 0 && (
            <div className="deck-activity-empty">
              No inbox items — capture via /capture or inbox_add MCP tool
            </div>
          )}
          {visibleItems.map((item) => (
            <div
              key={item.id}
              className="deck-activity-card deck-activity-card--clickable"
              onClick={() => openDetail(item.id)}
            >
              <div className="deck-activity-card-header">
                <span className={badgeClass(item.status)}>{item.status}</span>
                <span className="deck-activity-id">{item.id}</span>
                {item.linkedTaskId && (
                  <span className="deck-activity-meta">→ {item.linkedTaskId}</span>
                )}
                <span className="deck-activity-date">{formatDate(item.createdAt)}</span>
              </div>
              <div className="deck-activity-title">{item.content}</div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="deck-activity-overlay" onClick={closeDetail}>
          <div className="deck-activity-panel" onClick={(e) => e.stopPropagation()}>
            <div className="deck-activity-panel-header">
              <span className={badgeClass(selected.item.status)}>{selected.item.status}</span>
              <span className="deck-activity-id">{selected.item.id}</span>
              <button className="deck-activity-close" onClick={closeDetail}>
                ×
              </button>
            </div>
            <div className="deck-activity-panel-meta">
              Created {formatDate(selected.item.createdAt)}
              {selected.item.projectId ? ` — project ${selected.item.projectId}` : ' — global'}
              {selected.item.linkedTaskId && ` — linked ${selected.item.linkedTaskId}`}
            </div>

            <div className="deck-activity-section">
              <div className="deck-activity-section-title">Content</div>
              {editing ? (
                <>
                  <textarea
                    className="deck-inbox-input deck-inbox-textarea"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={4}
                  />
                  <div className="deck-inbox-actions">
                    <button
                      className="deck-sidebar-btn"
                      onClick={() => handleSaveEdit(selected.item.id)}
                    >
                      Save
                    </button>
                    <button className="deck-sidebar-btn" onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <div className="deck-activity-message-content">{selected.item.content}</div>
              )}
            </div>

            {selected.conversations.map((c) => (
              <div key={c.id} className="deck-activity-section">
                <div className="deck-activity-section-title">
                  Conversation {c.id} ({c.status})
                </div>
                {c.decisionSummary && (
                  <div className="deck-activity-decision">{c.decisionSummary}</div>
                )}
                {c.messages.map((m) => {
                  const collapsible = COLLAPSIBLE_TYPES.has(m.messageType)
                  const expanded = expandedMessages.has(m.id)
                  if (collapsible && !expanded) {
                    return (
                      <div
                        key={m.id}
                        className="deck-activity-message deck-activity-message--collapsed"
                        onClick={() => toggleMessage(m.id)}
                      >
                        <span className="deck-activity-message-type">{m.messageType}</span>
                        <span className="deck-activity-message-preview">
                          {m.content.slice(0, 80)}
                          {m.content.length > 80 ? '…' : ''}
                        </span>
                      </div>
                    )
                  }
                  return (
                    <div
                      key={m.id}
                      className="deck-activity-message"
                      onClick={collapsible ? () => toggleMessage(m.id) : undefined}
                    >
                      <div className="deck-activity-message-header">
                        <strong>{m.authorName}</strong>
                        <span className="deck-activity-message-type">{m.messageType}</span>
                        <span className="deck-activity-date">{formatDate(m.createdAt)}</span>
                      </div>
                      <div className="deck-activity-message-content">{m.content}</div>
                    </div>
                  )
                })}
              </div>
            ))}

            {converting ? (
              <div className="deck-activity-section">
                <div className="deck-activity-section-title">Convert to task</div>
                <input
                  className="deck-inbox-input"
                  placeholder="Task title…"
                  value={convertTitle}
                  onChange={(e) => setConvertTitle(e.target.value)}
                />
                <select
                  className="deck-inbox-select"
                  value={convertPriority}
                  onChange={(e) =>
                    setConvertPriority(e.target.value as 'critical' | 'high' | 'medium' | 'low')
                  }
                >
                  <option value="critical">critical</option>
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
                <div className="deck-inbox-actions">
                  <button className="deck-sidebar-btn" onClick={handleConvert}>
                    Create task
                  </button>
                  <button className="deck-sidebar-btn" onClick={() => setConverting(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              !editing && (
                <div className="deck-inbox-actions">
                  {selected.item.status === 'raw' && (
                    <button
                      className="deck-sidebar-btn"
                      onClick={() => handleResearch(selected.item.id)}
                    >
                      Start research
                    </button>
                  )}
                  {selected.item.status === 'researching' && (
                    <button
                      className="deck-sidebar-btn"
                      onClick={() => handleReady(selected.item.id)}
                    >
                      Mark ready
                    </button>
                  )}
                  {selected.item.status !== 'converted' &&
                    selected.item.status !== 'archived' && (
                      <button
                        className="deck-sidebar-btn"
                        onClick={() => {
                          setEditContent(selected.item.content)
                          setEditing(true)
                        }}
                      >
                        Edit
                      </button>
                    )}
                  {(selected.item.status === 'ready' ||
                    selected.item.status === 'researching' ||
                    selected.item.status === 'raw') && (
                    <button
                      className="deck-sidebar-btn"
                      onClick={() => {
                        setConvertTitle(selected.item.content.slice(0, 80))
                        setConverting(true)
                      }}
                    >
                      Convert to task
                    </button>
                  )}
                  {selected.item.status !== 'converted' &&
                    selected.item.status !== 'archived' && (
                      <button
                        className="deck-sidebar-btn"
                        onClick={() => handleArchive(selected.item.id)}
                      >
                        Archive
                      </button>
                    )}
                  {(selected.item.status === 'raw' || selected.item.status === 'archived') && (
                    <button
                      className="deck-sidebar-btn deck-sidebar-btn--danger"
                      onClick={() => handleDelete(selected.item.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  )
}
