import { useEffect, useState, useCallback } from 'react'
import MarkdownViewer from './MarkdownViewer'

const STATUSES = ['TODO', 'READY', 'IN-PROGRESS', 'DONE', 'CANCELLED'] as const

interface TaskDetail {
  task: {
    id: string
    title: string
    status: string
    priority: string | null
    labels: string[]
    phaseId: string | null
    dueDate: string | null
    filePath: string | null
    body: string | null
    createdAt: string
  }
  dependencies: Array<{ sourceId: string; targetId: string }>
  subtasks: Array<{ id: string; title: string; status: string }>
  body: string | null
}

interface TaskDetailPanelProps {
  taskId: string | null
  onClose: () => void
  onChanged?: () => void
  onTaskClick?: (taskId: string) => void
}

// Strip frontmatter (--- ... ---) from markdown content
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? content.slice(match[0].length) : content
}

function TaskDetailPanel({
  taskId,
  onClose,
  onChanged,
  onTaskClick
}: TaskDetailPanelProps): React.JSX.Element | null {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    if (!taskId) {
      setDetail(null)
      setEditing(false)
      return
    }

    let disposed = false
    setLoading(true)

    window.api.task.detail(taskId).then((result) => {
      if (!disposed) {
        setDetail(result as TaskDetail | null)
        setLoading(false)
      }
    })

    return () => {
      disposed = true
    }
  }, [taskId])

  // Close on Escape
  useEffect(() => {
    if (!taskId) return
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        if (editing) setEditing(false)
        else onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [taskId, onClose, editing])

  const handleStatusChange = useCallback(
    async (newStatus: string) => {
      if (!detail) return
      await window.api.task.update(detail.task.id, { status: newStatus })
      const result = await window.api.task.detail(detail.task.id)
      setDetail(result as TaskDetail | null)
      if (onChanged) onChanged()
    },
    [detail, onChanged]
  )

  const handleEdit = useCallback(() => {
    if (!detail) return
    setEditContent(detail.body ?? '')
    setEditing(true)
  }, [detail])

  const handleSave = useCallback(async () => {
    if (!detail) return
    setSaving(true)
    await window.api.task.update(detail.task.id, { body: editContent })
    const result = await window.api.task.detail(detail.task.id)
    setDetail(result as TaskDetail | null)
    setEditing(false)
    setSaving(false)
  }, [detail, editContent])

  if (!taskId) return null

  const body = detail?.body ? stripFrontmatter(detail.body).trim() : null

  return (
    <div className="deck-detail-overlay" onClick={onClose}>
      <div
        className={`deck-detail-modal${fullscreen ? ' deck-detail-modal--fullscreen' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="deck-detail-header">
          <span className="deck-detail-title">
            {loading ? 'Loading...' : detail?.task.id || taskId}
          </span>
          <div className="deck-detail-header-actions">
            {detail && !editing && (
              <button className="deck-sidebar-btn" onClick={handleEdit} title="Edit">
                Edit
              </button>
            )}
            <button
              className="deck-sidebar-add-btn"
              onClick={() => setFullscreen((f) => !f)}
              title={fullscreen ? 'Exit full screen' : 'Full screen'}
            >
              {fullscreen ? '⇲' : '⇱'}
            </button>
            <button className="deck-sidebar-add-btn" onClick={onClose} title="Close (Esc)">
              x
            </button>
          </div>
        </div>

        {detail && (
          <div className="deck-detail-body">
            <div className="deck-detail-top">
              <div className="deck-detail-meta">
                <h2 className="deck-detail-task-title">{detail.task.title}</h2>
                <div className="deck-detail-row">
                  <div className="deck-detail-field">
                    <span className="deck-detail-label">Status</span>
                    <select
                      className="deck-detail-status-select"
                      value={detail.task.status}
                      onChange={(e) => handleStatusChange(e.target.value)}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="deck-detail-field">
                    <span className="deck-detail-label">Priority</span>
                    <span className="deck-detail-value">{detail.task.priority || '-'}</span>
                  </div>
                  {detail.task.dueDate && (
                    <div className="deck-detail-field">
                      <span className="deck-detail-label">Due</span>
                      <span className="deck-detail-value">{detail.task.dueDate}</span>
                    </div>
                  )}
                </div>
                {detail.task.labels.length > 0 && (
                  <div className="deck-detail-field">
                    <span className="deck-detail-label">Labels</span>
                    <span className="deck-detail-value">{detail.task.labels.join(', ')}</span>
                  </div>
                )}
              </div>

              <div className="deck-detail-sidebar">
                {detail.dependencies.length > 0 && (
                  <div className="deck-detail-section">
                    <div className="deck-detail-section-title">Dependencies</div>
                    {detail.dependencies.map((dep, i) => (
                      <div
                        key={i}
                        className="deck-detail-dep deck-detail-dep--link"
                        onClick={() =>
                          onTaskClick?.(
                            dep.sourceId === detail.task.id ? dep.targetId : dep.sourceId
                          )
                        }
                        title="Open task"
                      >
                        {dep.sourceId === detail.task.id
                          ? `→ ${dep.targetId}`
                          : `← ${dep.sourceId}`}
                      </div>
                    ))}
                  </div>
                )}

                {detail.subtasks.length > 0 && (
                  <div className="deck-detail-section">
                    <div className="deck-detail-section-title">Subtasks</div>
                    {detail.subtasks.map((sub) => (
                      <div
                        key={sub.id}
                        className="deck-detail-subtask deck-detail-dep--link"
                        onClick={() => onTaskClick?.(sub.id)}
                        title="Open task"
                      >
                        <span
                          className={`deck-dot ${sub.status === 'DONE' ? 'deck-dot--green' : 'deck-dot--grey'}`}
                        />
                        <span>{sub.id}</span>
                        <span className="deck-detail-subtask-title">{sub.title}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Content section */}
            {editing ? (
              <div className="deck-detail-section">
                <div className="deck-detail-section-title">
                  Editing
                  <div className="deck-detail-edit-actions">
                    <button
                      className="deck-sidebar-btn deck-sidebar-btn--ok"
                      onClick={handleSave}
                      disabled={saving}
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button className="deck-sidebar-btn" onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
                <textarea
                  className="deck-detail-editor"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  spellCheck={false}
                />
              </div>
            ) : body ? (
              <div className="deck-detail-section">
                <div className="deck-detail-section-title">Content</div>
                <div className="deck-detail-md">
                  <MarkdownViewer
                    content={body}
                    filePath={detail.task.filePath || ''}
                    onWikilinkClick={() => {}}
                  />
                </div>
              </div>
            ) : (
              <div className="deck-detail-section">
                <div className="deck-detail-section-title">Content</div>
                <div className="deck-detail-empty">Empty — click Edit to add content</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default TaskDetailPanel
