import { useEffect, useState, useCallback } from 'react'
import MarkdownViewer from './MarkdownViewer'

const STATUSES = ['TODO', 'READY', 'IN-PROGRESS', 'DONE'] as const
const STATUS_TO_FM: Record<string, string> = {
  'TODO': 'todo',
  'READY': 'ready',
  'IN-PROGRESS': 'in-progress',
  'DONE': 'done'
}

// Update status field in frontmatter string
function updateFrontmatterStatus(content: string, newStatus: string): string {
  const fmStatus = STATUS_TO_FM[newStatus] || newStatus.toLowerCase()
  return content.replace(/^(---[\s\S]*?)(status:\s*).*([\s\S]*?---)/, `$1$2${fmStatus}$3`)
}

interface TaskDetail {
  task: {
    id: string
    title: string
    status: string
    priority: string | null
    labels: string[]
    featureId: string | null
    dueDate: string | null
    filePath: string | null
    createdAt: string
  }
  dependencies: Array<{ sourceId: string; targetId: string }>
  subtasks: Array<{ id: string; title: string; status: string }>
  fileContent: string | null
}

interface TaskDetailPanelProps {
  taskId: string | null
  onClose: () => void
  onChanged?: () => void
}

// Strip frontmatter (--- ... ---) from markdown content
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? content.slice(match[0].length) : content
}

function TaskDetailPanel({ taskId, onClose, onChanged }: TaskDetailPanelProps): React.JSX.Element | null {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [phases, setPhases] = useState<Array<{ id: string; title: string }>>([])
  const [features, setFeatures] = useState<Array<{ id: string; title: string; phaseId: string | null }>>([])

  // Load phases + features for the assign dropdown
  useEffect(() => {
    if (!taskId) return
    Promise.all([
      window.api.phase.list('choda-deck'),
      window.api.feature.list('choda-deck')
    ]).then(([ph, ft]) => {
      setPhases(ph as Array<{ id: string; title: string }>)
      setFeatures(ft as Array<{ id: string; title: string; phaseId: string | null }>)
    })
  }, [taskId])

  useEffect(() => {
    if (!taskId) { setDetail(null); setEditing(false); return }

    let disposed = false
    setLoading(true)

    window.api.task.detail(taskId).then((result) => {
      if (!disposed) {
        setDetail(result as TaskDetail | null)
        setLoading(false)
      }
    })

    return () => { disposed = true }
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

  const handleStatusChange = useCallback(async (newStatus: string) => {
    if (!detail) return
    // Update SQLite
    await window.api.task.update(detail.task.id, { status: newStatus })
    // Update .md frontmatter if file exists
    if (detail.task.filePath && detail.fileContent) {
      const updated = updateFrontmatterStatus(detail.fileContent, newStatus)
      await window.api.vault.write(detail.task.filePath, updated)
    }
    // Reload detail + notify parent
    const result = await window.api.task.detail(detail.task.id)
    setDetail(result as TaskDetail | null)
    if (onChanged) onChanged()
  }, [detail, onChanged])

  const handleFeatureChange = useCallback(async (featureId: string | null) => {
    if (!detail) return
    await window.api.task.update(detail.task.id, { featureId })
    const result = await window.api.task.detail(detail.task.id)
    setDetail(result as TaskDetail | null)
    if (onChanged) onChanged()
  }, [detail, onChanged])

  const handleEdit = useCallback(() => {
    if (!detail?.fileContent) return
    setEditContent(detail.fileContent)
    setEditing(true)
  }, [detail])

  const handleSave = useCallback(async () => {
    if (!detail?.task.filePath) return
    setSaving(true)
    await window.api.vault.write(detail.task.filePath, editContent)
    // Reload detail
    const result = await window.api.task.detail(detail.task.id)
    setDetail(result as TaskDetail | null)
    setEditing(false)
    setSaving(false)
  }, [detail, editContent])

  if (!taskId) return null

  const body = detail?.fileContent ? stripFrontmatter(detail.fileContent).trim() : null

  return (
    <div className="deck-detail-overlay" onClick={onClose}>
      <div className="deck-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="deck-detail-header">
          <span className="deck-detail-title">{loading ? 'Loading...' : detail?.task.id || taskId}</span>
          <div className="deck-detail-header-actions">
            {detail?.task.filePath && !editing && (
              <button className="deck-sidebar-btn" onClick={handleEdit} title="Edit">Edit</button>
            )}
            <button className="deck-sidebar-add-btn" onClick={onClose} title="Close (Esc)">x</button>
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
                        <option key={s} value={s}>{s}</option>
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
                <div className="deck-detail-field">
                  <span className="deck-detail-label">Feature</span>
                  <select
                    className="deck-detail-status-select"
                    value={detail.task.featureId || ''}
                    onChange={(e) => handleFeatureChange(e.target.value || null)}
                  >
                    <option value="">Unassigned</option>
                    {phases.map((ph) => (
                      <optgroup key={ph.id} label={ph.title}>
                        {features.filter(f => f.phaseId === ph.id).map((f) => (
                          <option key={f.id} value={f.id}>{f.title}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
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
                      <div key={i} className="deck-detail-dep">
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
                      <div key={sub.id} className="deck-detail-subtask">
                        <span className={`deck-dot ${sub.status === 'DONE' ? 'deck-dot--green' : 'deck-dot--grey'}`} />
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
                    <button className="deck-sidebar-btn deck-sidebar-btn--ok" onClick={handleSave} disabled={saving}>
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button className="deck-sidebar-btn" onClick={() => setEditing(false)}>Cancel</button>
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
                <div className="deck-detail-empty">
                  {detail.task.filePath ? 'Empty — click Edit to add content' : 'No file linked'}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default TaskDetailPanel
