import { useEffect, useState, useCallback, useMemo } from 'react'
import TaskDetailPanel from './TaskDetailPanel'
import PriorityPicker, { type Priority } from './components/PriorityPicker'

const STATUSES = ['TODO', 'READY', 'IN-PROGRESS', 'DONE', 'CANCELLED'] as const
const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const

interface TaskItem {
  id: string
  title: string
  status: string
  priority: string | null
  labels: string[]
  phaseId: string | null
  parentTaskId: string | null
}

interface KanbanBoardProps {
  projectId: string
  visible: boolean
}

function KanbanBoard({ projectId, visible }: KanbanBoardProps): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [filterText, setFilterText] = useState('')
  const [filterPriority, setFilterPriority] = useState<string>('')
  const [filterLabel, setFilterLabel] = useState<string>('')
  const [showDone, setShowDone] = useState(false)
  const [showCancelled, setShowCancelled] = useState(false)
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())
  const [subtasks, setSubtasks] = useState<Record<string, TaskItem[]>>({})
  const [showImport, setShowImport] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [dragTaskId, setDragTaskId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    const taskList = await window.api.task.list({ projectId })
    setTasks(taskList as TaskItem[])
  }, [projectId])

  useEffect(() => {
    if (!visible) return
    loadData()
    const cleanup = window.api.task.onChanged(() => loadData())
    return () => cleanup()
  }, [visible, projectId, loadData])

  // All unique labels across tasks
  const allLabels = useMemo(() => {
    const set = new Set<string>()
    for (const t of tasks) {
      for (const l of t.labels) set.add(l)
    }
    return Array.from(set).sort()
  }, [tasks])

  async function toggleExpand(taskId: string): Promise<void> {
    const next = new Set(expandedCards)
    if (next.has(taskId)) {
      next.delete(taskId)
    } else {
      next.add(taskId)
      if (!subtasks[taskId]) {
        const subs = (await window.api.task.subtasks(taskId)) as TaskItem[]
        setSubtasks((prev) => ({ ...prev, [taskId]: subs }))
      }
    }
    setExpandedCards(next)
  }

  const STATUS_TO_FM: Record<string, string> = {
    TODO: 'todo',
    READY: 'ready',
    'IN-PROGRESS': 'in-progress',
    DONE: 'done',
    CANCELLED: 'cancelled'
  }

  async function handleDrop(newStatus: string): Promise<void> {
    if (!dragTaskId) return
    const task = tasks.find((t) => t.id === dragTaskId)
    if (!task || task.status === newStatus) {
      setDragTaskId(null)
      setDropTarget(null)
      return
    }

    await window.api.task.update(dragTaskId, { status: newStatus })

    const detail = (await window.api.task.detail(dragTaskId)) as {
      task: { filePath: string | null }
      fileContent: string | null
    } | null
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

  async function handlePriorityChange(taskId: string, next: Priority): Promise<void> {
    const prev = tasks.find((t) => t.id === taskId)?.priority ?? null
    setTasks((list) => list.map((t) => (t.id === taskId ? { ...t, priority: next } : t)))
    try {
      await window.api.task.update(taskId, { priority: next })
    } catch (err) {
      setTasks((list) => list.map((t) => (t.id === taskId ? { ...t, priority: prev } : t)))
      alert(`Failed to update priority: ${(err as Error).message}`)
    }
  }

  async function handleImport(): Promise<void> {
    const result = await window.api.task.import()
    setImportResult(
      `Imported ${result.tasks} tasks, ${result.phases} phases, ${result.documents} docs, ${result.errors.length} errors`
    )
    setShowImport(false)
    loadData()
  }

  // Apply filters
  const visibleStatuses = STATUSES.filter((s) => {
    if (s === 'DONE' && !showDone) return false
    if (s === 'CANCELLED' && !showCancelled) return false
    return true
  })

  const rootTasks = tasks.filter((t) => !t.parentTaskId)
  const filtered = rootTasks.filter((t) => {
    if (!showDone && t.status === 'DONE') return false
    if (!showCancelled && t.status === 'CANCELLED') return false
    if (filterPriority && t.priority !== filterPriority) return false
    if (filterLabel && !t.labels.includes(filterLabel)) return false
    if (
      filterText &&
      !t.title.toLowerCase().includes(filterText.toLowerCase()) &&
      !t.id.toLowerCase().includes(filterText.toLowerCase())
    )
      return false
    return true
  })

  const activeFilterCount = [filterPriority, filterLabel, filterText].filter(Boolean).length

  return (
    <div className="deck-kanban">
      <div className="deck-kanban-toolbar">
        {/* Priority filter */}
        <select
          className="deck-sidebar-input"
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value)}
          title="Filter by priority"
        >
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        {/* Label filter */}
        <select
          className="deck-sidebar-input"
          value={filterLabel}
          onChange={(e) => setFilterLabel(e.target.value)}
          title="Filter by label"
        >
          <option value="">All labels</option>
          {allLabels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>

        {/* Text search */}
        <input
          className="deck-sidebar-input deck-kanban-search"
          placeholder="Search tasks..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />

        {/* Clear filters */}
        {activeFilterCount > 0 && (
          <button
            className="deck-sidebar-btn"
            onClick={() => {
              setFilterPriority('')
              setFilterLabel('')
              setFilterText('')
            }}
            title="Clear filters"
          >
            ✕ {activeFilterCount}
          </button>
        )}

        {/* Show Done toggle */}
        <button
          className={`deck-sidebar-btn${showDone ? ' deck-sidebar-btn--active' : ''}`}
          onClick={() => setShowDone((v) => !v)}
          title={showDone ? 'Hide done' : 'Show done'}
        >
          {showDone ? 'Hide Done' : 'Done'}
        </button>

        {/* Show Cancelled toggle */}
        <button
          className={`deck-sidebar-btn${showCancelled ? ' deck-sidebar-btn--active' : ''}`}
          onClick={() => setShowCancelled((v) => !v)}
          title={showCancelled ? 'Hide cancelled' : 'Show cancelled'}
        >
          {showCancelled ? 'Hide Cancelled' : 'Cancelled'}
        </button>

        <button
          className="deck-sidebar-btn"
          onClick={() => setShowImport(true)}
          title="Import from vault"
        >
          Import
        </button>
        <button className="deck-sidebar-btn" onClick={loadData} title="Refresh">
          ↻
        </button>
      </div>

      {importResult && (
        <div className="deck-kanban-import-result">
          {importResult}
          <button className="deck-sidebar-remove-btn" onClick={() => setImportResult(null)}>
            x
          </button>
        </div>
      )}

      {showImport && (
        <div className="deck-kanban-create">
          <div className="deck-sidebar-form-actions">
            <button className="deck-sidebar-btn deck-sidebar-btn--ok" onClick={handleImport}>
              Import from vault
            </button>
            <button className="deck-sidebar-btn" onClick={() => setShowImport(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="deck-kanban-columns">
        {visibleStatuses.map((status) => {
          const columnTasks = filtered.filter((t) => t.status === status)
          return (
            <div
              key={status}
              className={`deck-kanban-column${dropTarget === status ? ' deck-kanban-column--drop' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDropTarget(status)
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => {
                e.preventDefault()
                handleDrop(status)
              }}
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
                      onDragEnd={() => {
                        setDragTaskId(null)
                        setDropTarget(null)
                      }}
                      onClick={() => setSelectedTaskId(task.id)}
                    >
                      <div className="deck-kanban-card-header">
                        <span className="deck-kanban-card-id">{task.id}</span>
                        <PriorityPicker
                          value={task.priority}
                          onChange={(next) => handlePriorityChange(task.id, next)}
                        />
                      </div>
                      <div className="deck-kanban-card-title">{task.title}</div>

                      {task.labels.length > 0 && (
                        <div className="deck-kanban-labels">
                          {task.labels.map((l) => (
                            <span
                              key={l}
                              className={`deck-kanban-label${filterLabel === l ? ' deck-kanban-label--active' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setFilterLabel(filterLabel === l ? '' : l)
                              }}
                              title={`Filter by ${l}`}
                            >
                              {l}
                            </span>
                          ))}
                        </div>
                      )}

                      {hasSubtasks && (
                        <button
                          className="deck-kanban-subtask-toggle"
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleExpand(task.id)
                          }}
                        >
                          {isExpanded ? '▾' : '▸'} subtasks
                        </button>
                      )}

                      {isExpanded && subs.length > 0 && (
                        <div className="deck-kanban-subtasks">
                          {subs.map((sub) => (
                            <div key={sub.id} className="deck-kanban-subtask">
                              <span
                                className={`deck-dot ${sub.status === 'DONE' ? 'deck-dot--green' : 'deck-dot--grey'}`}
                              />
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
      <TaskDetailPanel
        taskId={selectedTaskId}
        onClose={() => setSelectedTaskId(null)}
        onChanged={loadData}
        onTaskClick={(id) => setSelectedTaskId(id)}
      />
    </div>
  )
}

export default KanbanBoard
