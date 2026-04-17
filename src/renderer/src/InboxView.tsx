import { useEffect, useState } from 'react'

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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })
}

function statusColor(status: string): string {
  const map: Record<string, string> = {
    raw: '#f59e0b',
    researching: '#3b82f6',
    ready: '#10b981',
    converted: '#6b7280',
    archived: '#6b6b6b',
    open: '#f59e0b',
    closed: '#6b7280'
  }
  return map[status] ?? '#6b7280'
}

export default function InboxView({ projectId, visible }: InboxViewProps): React.JSX.Element {
  const [items, setItems] = useState<InboxItem[]>([])
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [statusFilter, setStatusFilter] = useState<InboxStatus | 'all'>('all')
  const [loading, setLoading] = useState(false)
  const [addContent, setAddContent] = useState('')
  const [selected, setSelected] = useState<InboxDetail | null>(null)
  const [converting, setConverting] = useState(false)
  const [convertTitle, setConvertTitle] = useState('')
  const [convertPriority, setConvertPriority] = useState<'critical' | 'high' | 'medium' | 'low'>(
    'medium'
  )
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setLoading(true)
    const filter: { projectId?: string | null; status?: string } = {
      projectId: scope === 'global' ? null : projectId
    }
    if (statusFilter !== 'all') filter.status = statusFilter
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
  }, [projectId, scope, statusFilter, visible, reloadTick])

  async function handleAdd(): Promise<void> {
    const content = addContent.trim()
    if (!content) return
    await window.api.inbox.add({
      projectId: scope === 'global' ? null : projectId,
      content
    })
    setAddContent('')
    setReloadTick((t) => t + 1)
  }

  async function openDetail(id: string): Promise<void> {
    const detail = (await window.api.inbox.get(id)) as InboxDetail | null
    if (detail) setSelected(detail)
  }

  async function handleArchive(id: string): Promise<void> {
    if (!confirm(`Archive ${id}?`)) return
    await window.api.inbox.archive(id)
    setSelected(null)
    setReloadTick((t) => t + 1)
  }

  async function handleDelete(id: string): Promise<void> {
    if (!confirm(`Delete ${id}? (only raw/archived allowed)`)) return
    const res = await window.api.inbox.delete(id)
    if (!res.ok) {
      alert(res.error || 'Delete failed')
      return
    }
    setSelected(null)
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
    setSelected(null)
    setReloadTick((t) => t + 1)
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
          <select
            className="deck-inbox-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as InboxStatus | 'all')}
          >
            <option value="all">All statuses</option>
            <option value="raw">Raw</option>
            <option value="researching">Researching</option>
            <option value="ready">Ready</option>
            <option value="converted">Converted</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <div className="deck-inbox-add">
          <input
            className="deck-inbox-input"
            placeholder="Capture a raw idea…"
            value={addContent}
            onChange={(e) => setAddContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleAdd()
              }
            }}
          />
          <button className="deck-sidebar-btn" onClick={handleAdd}>
            Add
          </button>
        </div>
      </div>

      {loading && <div className="deck-activity-empty">Loading…</div>}

      {!loading && (
        <div className="deck-activity-list">
          {items.length === 0 && <div className="deck-activity-empty">No inbox items</div>}
          {items.map((item) => (
            <div
              key={item.id}
              className="deck-activity-card deck-activity-card--clickable"
              onClick={() => openDetail(item.id)}
            >
              <div className="deck-activity-card-header">
                <span
                  className="deck-activity-badge"
                  style={{ background: statusColor(item.status) }}
                >
                  {item.status}
                </span>
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
        <div className="deck-activity-overlay" onClick={() => setSelected(null)}>
          <div className="deck-activity-panel" onClick={(e) => e.stopPropagation()}>
            <div className="deck-activity-panel-header">
              <span
                className="deck-activity-badge"
                style={{ background: statusColor(selected.item.status) }}
              >
                {selected.item.status}
              </span>
              <span className="deck-activity-id">{selected.item.id}</span>
              <button className="deck-activity-close" onClick={() => setSelected(null)}>
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
              <div className="deck-activity-message-content">{selected.item.content}</div>
            </div>

            {selected.conversations.map((c) => (
              <div key={c.id} className="deck-activity-section">
                <div className="deck-activity-section-title">
                  Conversation {c.id} ({c.status})
                </div>
                {c.decisionSummary && (
                  <div className="deck-activity-decision">{c.decisionSummary}</div>
                )}
                {c.messages.map((m) => (
                  <div key={m.id} className="deck-activity-message">
                    <div className="deck-activity-message-header">
                      <strong>{m.authorName}</strong>
                      <span className="deck-activity-message-type">{m.messageType}</span>
                      <span className="deck-activity-date">{formatDate(m.createdAt)}</span>
                    </div>
                    <div className="deck-activity-message-content">{m.content}</div>
                  </div>
                ))}
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
                    setConvertPriority(
                      e.target.value as 'critical' | 'high' | 'medium' | 'low'
                    )
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
              <div className="deck-inbox-actions">
                {selected.item.status !== 'converted' && selected.item.status !== 'archived' && (
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
                {selected.item.status !== 'converted' && selected.item.status !== 'archived' && (
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
            )}
          </div>
        </div>
      )}
    </div>
  )
}
