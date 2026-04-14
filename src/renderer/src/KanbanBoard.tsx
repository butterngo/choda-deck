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

interface PhaseItem {
  id: string
  title: string
  status: string
}

interface FeatureItem {
  id: string
  title: string
  phaseId: string | null
}

interface KanbanBoardProps {
  projectId: string
  visible: boolean
}

function KanbanBoard({ projectId, visible }: KanbanBoardProps): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [phases, setPhases] = useState<PhaseItem[]>([])
  const [features, setFeatures] = useState<FeatureItem[]>([])
  const [activePhaseId, setActivePhaseId] = useState<string | null>(null)
  const [phaseStatus, setPhaseStatus] = useState<Record<string, string>>({})
  const [filterText, setFilterText] = useState('')
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())
  const [subtasks, setSubtasks] = useState<Record<string, TaskItem[]>>({})
  const [showImport, setShowImport] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [dragTaskId, setDragTaskId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [filterFeatureId, setFilterFeatureId] = useState<string | null>(null)

  // Listen for feature filter from RoadmapView
  useEffect(() => {
    function handleFilter(e: Event): void {
      const detail = (e as CustomEvent).detail
      if (detail?.featureId) {
        setFilterFeatureId(detail.featureId)
        // Also set the phase that contains this feature
        if (detail.phaseId) setActivePhaseId(detail.phaseId)
      }
    }
    window.addEventListener('deck:filter-feature', handleFilter)
    return () => window.removeEventListener('deck:filter-feature', handleFilter)
  }, [])

  const loadData = useCallback(async () => {
    const [taskList, phaseList, featureList] = await Promise.all([
      window.api.task.list({ projectId }),
      window.api.phase.list(projectId),
      window.api.feature.list(projectId)
    ])
    setTasks(taskList as TaskItem[])
    setPhases(phaseList as PhaseItem[])
    setFeatures(featureList as FeatureItem[])

    // Load phase derived status
    const ps: Record<string, string> = {}
    for (const ph of phaseList as PhaseItem[]) {
      const prog = await window.api.phase.progress(ph.id)
      ps[ph.id] = prog.status
    }
    setPhaseStatus(ps)

    // Auto-select active phase: first open phase with non-DONE tasks
    if (!activePhaseId) {
      const allTasks = taskList as TaskItem[]
      const allFeatures = featureList as FeatureItem[]
      for (const ph of phaseList as PhaseItem[]) {
        if (ph.status === 'closed') continue
        const phFeatureIds = allFeatures.filter(f => f.phaseId === ph.id).map(f => f.id)
        const phTasks = allTasks.filter(t => t.featureId && phFeatureIds.includes(t.featureId))
        const hasActive = phTasks.some(t => t.status !== 'DONE')
        if (hasActive) {
          setActivePhaseId(ph.id)
          break
        }
      }
    }
  }, [projectId, activePhaseId])

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

  const STATUS_TO_FM: Record<string, string> = {
    'TODO': 'todo', 'READY': 'ready', 'IN-PROGRESS': 'in-progress', 'DONE': 'done'
  }

  async function handleDrop(newStatus: string): Promise<void> {
    if (!dragTaskId || dragTaskId === newStatus) return
    const task = tasks.find(t => t.id === dragTaskId)
    if (!task || task.status === newStatus) { setDragTaskId(null); setDropTarget(null); return }

    // Update SQLite
    await window.api.task.update(dragTaskId, { status: newStatus })

    // Sync .md frontmatter
    const detail = await window.api.task.detail(dragTaskId) as { task: { filePath: string | null }; fileContent: string | null } | null
    if (detail?.task.filePath && detail.fileContent) {
      const fmStatus = STATUS_TO_FM[newStatus] || newStatus.toLowerCase()
      const updated = detail.fileContent.replace(
        /^(---[\s\S]*?)(status:\s*).*([\s\S]*?---)/,
        `$1$2${fmStatus}$3`
      )
      await window.api.vault.write(detail.task.filePath, updated)
    }

    setDragTaskId(null)
    setDropTarget(null)
    loadData()
  }

  async function handleImport(): Promise<void> {
    const result = await window.api.task.import()
    setImportResult(`Imported ${result.tasks} tasks, ${result.phases} phases, ${result.documents} docs, ${result.errors.length} errors`)
    setShowImport(false)
    loadData()
  }

  // Get tasks: filter by feature if set, otherwise by phase
  let visibleTasks: TaskItem[]
  if (filterFeatureId) {
    visibleTasks = tasks.filter(t => t.featureId === filterFeatureId)
  } else if (activePhaseId) {
    const activeFeatureIds = features
      .filter(f => f.phaseId === activePhaseId)
      .map(f => f.id)
    visibleTasks = tasks.filter(t => t.featureId && activeFeatureIds.includes(t.featureId))
  } else {
    visibleTasks = tasks
  }

  // Filter: text + root tasks only
  const rootTasks = visibleTasks.filter((t) => !t.parentTaskId)
  const filtered = rootTasks.filter((t) => {
    if (filterText && !t.title.toLowerCase().includes(filterText.toLowerCase())) return false
    return true
  })

  return (
    <div className="deck-kanban">
      <div className="deck-kanban-toolbar">
        <select
          className="deck-sidebar-input"
          value={activePhaseId || ''}
          onChange={(e) => { setActivePhaseId(e.target.value || null); setFilterFeatureId(null) }}
        >
          <option value="">All phases</option>
          {phases.map((ph) => (
            <option key={ph.id} value={ph.id}>{ph.title} [{phaseStatus[ph.id] || '...'}]</option>
          ))}
        </select>
        <select
          className="deck-sidebar-input"
          value={filterFeatureId || ''}
          onChange={(e) => setFilterFeatureId(e.target.value || null)}
        >
          <option value="">All features</option>
          {features
            .filter(f => !activePhaseId || f.phaseId === activePhaseId)
            .map((f) => (
              <option key={f.id} value={f.id}>{f.title}</option>
            ))
          }
        </select>
        <input
          className="deck-sidebar-input deck-kanban-search"
          placeholder="Filter tasks..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
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

      {/* Kanban columns */}
      <div className="deck-kanban-columns">
        {STATUSES.map((status) => {
          const columnTasks = filtered.filter((t) => t.status === status)
          return (
            <div
              key={status}
              className={`deck-kanban-column${dropTarget === status ? ' deck-kanban-column--drop' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDropTarget(status) }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => { e.preventDefault(); handleDrop(status) }}
            >
              <div className="deck-kanban-column-header">
                <span className="deck-kanban-column-title">{status}</span>
                <span className="deck-kanban-column-count">{columnTasks.length}</span>
              </div>
              <div className="deck-kanban-column-body">
                {columnTasks.map((task) => {
                  const isExpanded = expandedCards.has(task.id)
                  const subs = subtasks[task.id] || []
                  const hasSubtasks = tasks.some((t) => t.parentTaskId === task.id)

                  return (
                    <div
                      key={task.id}
                      className={`deck-kanban-card${dragTaskId === task.id ? ' deck-kanban-card--dragging' : ''}`}
                      draggable
                      onDragStart={() => setDragTaskId(task.id)}
                      onDragEnd={() => { setDragTaskId(null); setDropTarget(null) }}
                      onClick={() => setSelectedTaskId(task.id)}
                    >
                      <div className="deck-kanban-card-header">
                        <span className="deck-kanban-card-id">{task.id}</span>
                        {task.priority && (
                          <span className={`deck-kanban-badge deck-kanban-badge--${task.priority}`}>
                            {task.priority}
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
      <TaskDetailPanel taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} onChanged={loadData} />
    </div>
  )
}

export default KanbanBoard
