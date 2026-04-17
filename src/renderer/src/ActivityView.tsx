import { useEffect, useState } from 'react'

interface Session {
  id: string
  projectId: string
  workspaceId: string | null
  status: string
  startedAt: string
  endedAt: string | null
  taskId: string | null
  handoff: {
    resumePoint?: string
    commits?: string[]
    decisions?: string[]
    looseEnds?: string[]
    tasksUpdated?: string[]
  } | null
}

interface Conversation {
  id: string
  projectId: string
  title: string
  status: string
  createdBy: string
  decisionSummary: string | null
  createdAt: string
  decidedAt: string | null
  closedAt: string | null
}

interface ConversationMessage {
  id: string
  authorName: string
  content: string
  messageType: string
  createdAt: string
}

interface ConversationAction {
  id: string
  assignee: string
  description: string
  status: string
  linkedTaskId: string | null
}

interface ConversationDetail extends Conversation {
  messages: ConversationMessage[]
  actions: ConversationAction[]
}

interface ActivityViewProps {
  projectId: string
  visible: boolean
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    open: '#f59e0b',
    discussing: '#3b82f6',
    decided: '#8b5cf6',
    closed: '#6b7280',
    stale: '#ef4444',
    active: '#10b981',
    completed: '#6b7280',
    abandoned: '#ef4444'
  }
  return map[status] ?? '#6b7280'
}

export default function ActivityView({ projectId, visible }: ActivityViewProps): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [tab, setTab] = useState<'conversations' | 'sessions'>('conversations')
  const [loading, setLoading] = useState(false)
  const [selectedConv, setSelectedConv] = useState<ConversationDetail | null>(null)
  const [selectedSession, setSelectedSession] = useState<Session | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setLoading(true)
    Promise.all([window.api.session.list(projectId), window.api.conversation.list(projectId)])
      .then(([s, c]) => {
        if (cancelled) return
        setSessions((s as Session[]).slice().reverse())
        setConversations((c as Conversation[]).slice().reverse())
        setLoading(false)
      })
      .catch(() => setLoading(false))
    return () => {
      cancelled = true
    }
  }, [projectId, visible, reloadTick])

  async function openConversation(id: string): Promise<void> {
    const detail = (await window.api.conversation.read(id)) as ConversationDetail | null
    if (detail) setSelectedConv(detail)
  }

  async function copyId(id: string): Promise<void> {
    await navigator.clipboard.writeText(id)
    setCopiedId(id)
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1200)
  }

  async function deleteConversation(id: string): Promise<void> {
    if (!confirm(`Delete conversation ${id}?`)) return
    await window.api.conversation.delete(id)
    setSelectedConv(null)
    setReloadTick((t) => t + 1)
  }

  async function deleteSession(id: string): Promise<void> {
    if (!confirm(`Delete session ${id}?`)) return
    await window.api.session.delete(id)
    setSelectedSession(null)
    setReloadTick((t) => t + 1)
  }

  if (!visible) return <></>

  return (
    <div className="deck-activity">
      <div className="deck-activity-tabs">
        <button
          className={`deck-tab${tab === 'conversations' ? ' deck-tab--active' : ''}`}
          onClick={() => setTab('conversations')}
        >
          Conversations ({conversations.length})
        </button>
        <button
          className={`deck-tab${tab === 'sessions' ? ' deck-tab--active' : ''}`}
          onClick={() => setTab('sessions')}
        >
          Sessions ({sessions.length})
        </button>
      </div>

      {loading && <div className="deck-activity-empty">Loading…</div>}

      {!loading && tab === 'conversations' && (
        <div className="deck-activity-list">
          {conversations.length === 0 && (
            <div className="deck-activity-empty">No conversations yet</div>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className="deck-activity-card deck-activity-card--clickable"
              onClick={() => openConversation(c.id)}
            >
              <div className="deck-activity-card-header">
                <span className="deck-activity-badge" style={{ background: statusBadge(c.status) }}>
                  {c.status}
                </span>
                <span className="deck-activity-id">{c.id}</span>
                <button
                  className="deck-activity-icon-btn"
                  title="Copy ID"
                  onClick={(e) => {
                    e.stopPropagation()
                    copyId(c.id)
                  }}
                >
                  {copiedId === c.id ? '✓' : '⧉'}
                </button>
                <button
                  className="deck-activity-icon-btn deck-activity-icon-btn--danger"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteConversation(c.id)
                  }}
                >
                  ×
                </button>
                <span className="deck-activity-date">{formatDate(c.createdAt)}</span>
              </div>
              <div className="deck-activity-title">{c.title}</div>
              {c.decisionSummary && (
                <div className="deck-activity-decision">{c.decisionSummary}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {!loading && tab === 'sessions' && (
        <div className="deck-activity-list">
          {sessions.length === 0 && <div className="deck-activity-empty">No sessions yet</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className="deck-activity-card deck-activity-card--clickable"
              onClick={() => setSelectedSession(s)}
            >
              <div className="deck-activity-card-header">
                <span className="deck-activity-badge" style={{ background: statusBadge(s.status) }}>
                  {s.status}
                </span>
                <span className="deck-activity-id">{s.id}</span>
                <button
                  className="deck-activity-icon-btn"
                  title="Copy ID"
                  onClick={(e) => {
                    e.stopPropagation()
                    copyId(s.id)
                  }}
                >
                  {copiedId === s.id ? '✓' : '⧉'}
                </button>
                <button
                  className="deck-activity-icon-btn deck-activity-icon-btn--danger"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteSession(s.id)
                  }}
                >
                  ×
                </button>
                <span className="deck-activity-date">{formatDate(s.startedAt)}</span>
              </div>
              {s.taskId && <div className="deck-activity-meta">Task: {s.taskId}</div>}
              {s.handoff?.resumePoint && (
                <div className="deck-activity-decision">{s.handoff.resumePoint}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {selectedConv && (
        <div className="deck-activity-overlay" onClick={() => setSelectedConv(null)}>
          <div className="deck-activity-panel" onClick={(e) => e.stopPropagation()}>
            <div className="deck-activity-panel-header">
              <span
                className="deck-activity-badge"
                style={{ background: statusBadge(selectedConv.status) }}
              >
                {selectedConv.status}
              </span>
              <span className="deck-activity-id">{selectedConv.id}</span>
              <button
                className="deck-activity-icon-btn"
                title="Copy ID"
                onClick={() => copyId(selectedConv.id)}
              >
                {copiedId === selectedConv.id ? '✓' : '⧉'}
              </button>
              <button
                className="deck-activity-icon-btn deck-activity-icon-btn--danger"
                title="Delete"
                onClick={() => deleteConversation(selectedConv.id)}
              >
                🗑
              </button>
              <button className="deck-activity-close" onClick={() => setSelectedConv(null)}>
                ×
              </button>
            </div>
            <h3 className="deck-activity-panel-title">{selectedConv.title}</h3>
            <div className="deck-activity-panel-meta">
              Created by {selectedConv.createdBy || 'unknown'} —{' '}
              {formatDate(selectedConv.createdAt)}
            </div>

            {selectedConv.decisionSummary && (
              <div className="deck-activity-section">
                <div className="deck-activity-section-title">Decision</div>
                <div className="deck-activity-decision">{selectedConv.decisionSummary}</div>
              </div>
            )}

            <div className="deck-activity-section">
              <div className="deck-activity-section-title">
                Messages ({selectedConv.messages.length})
              </div>
              {selectedConv.messages.map((m) => (
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

            {selectedConv.actions.length > 0 && (
              <div className="deck-activity-section">
                <div className="deck-activity-section-title">
                  Actions ({selectedConv.actions.length})
                </div>
                {selectedConv.actions.map((a) => (
                  <div key={a.id} className="deck-activity-action">
                    <span
                      className="deck-activity-badge"
                      style={{ background: statusBadge(a.status) }}
                    >
                      {a.status}
                    </span>
                    <strong>{a.assignee}</strong>: {a.description}
                    {a.linkedTaskId && (
                      <span className="deck-activity-meta"> → {a.linkedTaskId}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {selectedSession && (
        <div className="deck-activity-overlay" onClick={() => setSelectedSession(null)}>
          <div className="deck-activity-panel" onClick={(e) => e.stopPropagation()}>
            <div className="deck-activity-panel-header">
              <span
                className="deck-activity-badge"
                style={{ background: statusBadge(selectedSession.status) }}
              >
                {selectedSession.status}
              </span>
              <span className="deck-activity-id">{selectedSession.id}</span>
              <button
                className="deck-activity-icon-btn"
                title="Copy ID"
                onClick={() => copyId(selectedSession.id)}
              >
                {copiedId === selectedSession.id ? '✓' : '⧉'}
              </button>
              <button
                className="deck-activity-icon-btn deck-activity-icon-btn--danger"
                title="Delete"
                onClick={() => deleteSession(selectedSession.id)}
              >
                🗑
              </button>
              <button className="deck-activity-close" onClick={() => setSelectedSession(null)}>
                ×
              </button>
            </div>
            <div className="deck-activity-panel-meta">
              Started: {formatDate(selectedSession.startedAt)}
              {selectedSession.endedAt && <> — Ended: {formatDate(selectedSession.endedAt)}</>}
            </div>
            {selectedSession.workspaceId && (
              <div className="deck-activity-meta">Workspace: {selectedSession.workspaceId}</div>
            )}
            {selectedSession.taskId && (
              <div className="deck-activity-meta">Task: {selectedSession.taskId}</div>
            )}

            {selectedSession.handoff && (
              <>
                {selectedSession.handoff.resumePoint && (
                  <div className="deck-activity-section">
                    <div className="deck-activity-section-title">Resume point</div>
                    <div className="deck-activity-message-content">
                      {selectedSession.handoff.resumePoint}
                    </div>
                  </div>
                )}
                {selectedSession.handoff.decisions &&
                  selectedSession.handoff.decisions.length > 0 && (
                    <div className="deck-activity-section">
                      <div className="deck-activity-section-title">Decisions</div>
                      {selectedSession.handoff.decisions.map((d, i) => (
                        <div key={i} className="deck-activity-message-content">
                          • {d}
                        </div>
                      ))}
                    </div>
                  )}
                {selectedSession.handoff.commits && selectedSession.handoff.commits.length > 0 && (
                  <div className="deck-activity-section">
                    <div className="deck-activity-section-title">Commits</div>
                    {selectedSession.handoff.commits.map((c, i) => (
                      <div key={i} className="deck-activity-message-content deck-activity-mono">
                        {c}
                      </div>
                    ))}
                  </div>
                )}
                {selectedSession.handoff.looseEnds &&
                  selectedSession.handoff.looseEnds.length > 0 && (
                    <div className="deck-activity-section">
                      <div className="deck-activity-section-title">Loose ends</div>
                      {selectedSession.handoff.looseEnds.map((l, i) => (
                        <div key={i} className="deck-activity-message-content">
                          • {l}
                        </div>
                      ))}
                    </div>
                  )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
