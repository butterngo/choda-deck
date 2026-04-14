import { useEffect, useState, useCallback } from 'react'
import TaskDetailPanel from './TaskDetailPanel'

const STATUSES = ['TODO', 'READY', 'IN-PROGRESS', 'DONE'] as const

interface TaskItem {
  id: string
  title: string
  status: string
  priority: string | null
  labels: string[]
  featureId: string | null
  parentTaskId: string | null
}

interface FeatureItem {
  id: string
  title: string
}

interface KanbanBoardProps {
  projectId: string
  visible: boolean
}

function KanbanBoard({ projectId, visible }: KanbanBoardProps): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [features, setFeatures] = useState<FeatureItem[]>([])
  const [featureProgress, setFeatureProgress] = useState<Record<string, { total: number; done: number }>>({})
  const [filterText, setFilterText] = useState('')
  const [filterFeature, setFilterFeature] = useState<string>('all')
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())
  const [subtasks, setSubtasks] = useState<Record<string, TaskItem[]>>({})
  const [showImport, setShowImport] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    const [taskList, featureList] = await Promise.all([
      window.api.task.list({ projectId: projectId }),
      window.api.feature.list(projectId)
    ])
    setTasks(taskList as TaskItem[])
    setFeatures(featureList as FeatureItem[])

    const progress: Record<string, { total: number; done: number }> = {}
    for (const feat of featureList as FeatureItem[]) {
      progress[feat.id] = await window.api.feature.progress(feat.id)
    }
    setFeatureProgress(progress)
  }, [projectId])

  useEffect(() => {
    if (!visible) return

    loadData()

    const cleanup = window.api.task.onChanged(() => loadData())
    return () => cleanup()
  }, [visible, projectId, loadData])

  async function toggleExpand(taskId: string): Promise<void> {
    const next = new Set(expandedCards)
    if (next.has(taskId)) {
      next.delete(taskId)
    } else {
      next.add(taskId)
      if (!subtasks[taskId]) {
        const subs = await window.api.task.subtasks(taskId) as TaskItem[]
        setSubtasks((prev) => ({ ...prev, [taskId]: subs }))
      }
    }
    setExpandedCards(next)
  }

  async function handleImport(): Promise<void> {
    const result = await window.api.task.import()
    setImportResult(`Imported ${result.tasks} tasks, ${result.phases} phases, ${result.documents} docs, ${result.errors.length} errors`)
    setShowImport(false)
    loadData()
  }

  // Filter: text + feature, root tasks only
  const rootTasks = tasks.filter((t) => !t.parentTaskId)
  const filtered = rootTasks.filter((t) => {
    if (filterText && !t.title.toLowerCase().includes(filterText.toLowerCase())) return false
    if (filterFeature !== 'all') {
      if (filterFeature === 'none' && t.featureId) return false
      if (filterFeature !== 'none' && t.featureId !== filterFeature) return false
    }
    return true
  })

  return (
    <div className="deck-kanban">
      <div className="deck-kanban-toolbar">
        <input
          className="deck-sidebar-input deck-kanban-search"
          placeholder="Filter tasks..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        {features.length > 0 && (
          <select
            className="deck-sidebar-input deck-kanban-epic-filter"
            value={filterFeature}
            onChange={(e) => setFilterFeature(e.target.value)}
          >
            <option value="all">All features</option>
            <option value="none">No feature</option>
            {features.map((f) => (
              <option key={f.id} value={f.id}>{f.title}</option>
            ))}
          </select>
        )}
        <button className="deck-sidebar-btn" onClick={() => setShowImport(true)} title="Import from vault">
          Import
        </button>
        <button className="deck-sidebar-btn" onClick={loadData} title="Refresh">
          ↻
        </button>
      </div>

      {importResult && (
        <div className="deck-kanban-import-result">
          {importResult}
          <button className="deck-sidebar-remove-btn" onClick={() => setImportResult(null)}>x</button>
        </div>
      )}

      {showImport && (
        <div className="deck-kanban-create">
          <div className="deck-sidebar-form-actions">
            <button className="deck-sidebar-btn deck-sidebar-btn--ok" onClick={handleImport}>Import from vault</button>
            <button className="deck-sidebar-btn" onClick={() => setShowImport(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Feature progress bar */}
      {features.length > 0 && (
        <div className="deck-epic-bar">
          {features.map((feat) => {
            const prog = featureProgress[feat.id] || { total: 0, done: 0 }
            const pct = prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0
            return (
              <div key={feat.id} className="deck-epic-chip">
                <span className="deck-epic-chip-title">{feat.title}</span>
                <div className="deck-epic-progress-bar">
                  <div className="deck-epic-progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="deck-epic-chip-count">{prog.done}/{prog.total}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Kanban columns — read-only */}
      <div className="deck-kanban-columns">
        {STATUSES.map((status) => {
          const columnTasks = filtered.filter((t) => t.status === status)
          return (
            <div key={status} className="deck-kanban-column">
              <div className="deck-kanban-column-header">
                <span className="deck-kanban-column-title">{status}</span>
                <span className="deck-kanban-column-count">{columnTasks.length}</span>
              </div>
              <div className="deck-kanban-column-body">
                {columnTasks.map((task) => {
                  const feat = task.featureId ? features.find((f) => f.id === task.featureId) : null
                  const isExpanded = expandedCards.has(task.id)
                  const subs = subtasks[task.id] || []
                  const hasSubtasks = tasks.some((t) => t.parentTaskId === task.id)

                  return (
                    <div key={task.id} className="deck-kanban-card" onClick={() => setSelectedTaskId(task.id)}>
                      <div className="deck-kanban-card-header">
                        <span className="deck-kanban-card-id">{task.id}</span>
                        {task.priority && (
                          <span className={`deck-kanban-badge deck-kanban-badge--${task.priority}`}>
                            {task.priority}
                          </span>
                        )}
                        {feat && (
                          <span className="deck-kanban-badge deck-kanban-badge--epic">
                            {feat.title}
                          </span>
                        )}
                      </div>
                      <div className="deck-kanban-card-title">{task.title}</div>

                      {hasSubtasks && (
                        <button
                          className="deck-kanban-subtask-toggle"
                          onClick={() => toggleExpand(task.id)}
                        >
                          {isExpanded ? '▾' : '▸'} subtasks
                        </button>
                      )}

                      {isExpanded && subs.length > 0 && (
                        <div className="deck-kanban-subtasks">
                          {subs.map((sub) => (
                            <div key={sub.id} className="deck-kanban-subtask">
                              <span className={`deck-dot ${sub.status === 'DONE' ? 'deck-dot--green' : 'deck-dot--grey'}`} />
                              <span className="deck-kanban-subtask-title">{sub.title}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <TaskDetailPanel taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
    </div>
  )
}

export default KanbanBoard
