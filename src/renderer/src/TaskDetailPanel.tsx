import { useEffect, useState } from 'react'

interface TaskDetail {
  task: {
    id: string
    title: string
    status: string
    priority: string | null
    labels: string[]
    epicId: string | null
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
}

function TaskDetailPanel({ taskId, onClose }: TaskDetailPanelProps): React.JSX.Element | null {
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!taskId) { setDetail(null); return }

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

  if (!taskId) return null

  return (
    <div className="deck-detail-panel">
      <div className="deck-detail-header">
        <span className="deck-detail-title">{loading ? 'Loading...' : detail?.task.id || taskId}</span>
        <button className="deck-sidebar-add-btn" onClick={onClose} title="Close">x</button>
      </div>

      {detail && (
        <div className="deck-detail-body">
          {/* Metadata */}
          <div className="deck-detail-meta">
            <div className="deck-detail-field">
              <span className="deck-detail-label">Title</span>
              <span className="deck-detail-value">{detail.task.title}</span>
            </div>
            <div className="deck-detail-row">
              <div className="deck-detail-field">
                <span className="deck-detail-label">Status</span>
                <span className="deck-detail-value">{detail.task.status}</span>
              </div>
              <div className="deck-detail-field">
                <span className="deck-detail-label">Priority</span>
                <span className="deck-detail-value">{detail.task.priority || '-'}</span>
              </div>
            </div>
            {detail.task.dueDate && (
              <div className="deck-detail-field">
                <span className="deck-detail-label">Due</span>
                <span className="deck-detail-value">{detail.task.dueDate}</span>
              </div>
            )}
            {detail.task.labels.length > 0 && (
              <div className="deck-detail-field">
                <span className="deck-detail-label">Labels</span>
                <span className="deck-detail-value">{detail.task.labels.join(', ')}</span>
              </div>
            )}
          </div>

          {/* Dependencies */}
          {detail.dependencies.length > 0 && (
            <div className="deck-detail-section">
              <div className="deck-detail-section-title">Dependencies</div>
              {detail.dependencies.map((dep, i) => (
                <div key={i} className="deck-detail-dep">
                  {dep.sourceId === detail.task.id
                    ? `→ depends on ${dep.targetId}`
                    : `← depended by ${dep.sourceId}`}
                </div>
              ))}
            </div>
          )}

          {/* Subtasks */}
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

          {/* File content */}
          <div className="deck-detail-section">
            <div className="deck-detail-section-title">File Content</div>
            {detail.fileContent ? (
              <pre className="deck-detail-content">{detail.fileContent}</pre>
            ) : (
              <div className="deck-detail-empty">No file content</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default TaskDetailPanel
