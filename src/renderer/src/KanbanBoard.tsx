import { useEffect, useState, useCallback } from 'react'
import type { SpikeProject } from '../../preload/index'

const STATUSES = ['TODO', 'READY', 'IN-PROGRESS', 'DONE'] as const

interface TaskItem {
  id: string
  title: string
  status: string
  priority: string | null
  labels: string[]
  epicId: string | null
  parentTaskId: string | null
}

interface EpicItem {
  id: string
  title: string
  status: string
}

interface KanbanBoardProps {
  project: SpikeProject
  visible: boolean
}

function KanbanBoard({ project, visible }: KanbanBoardProps): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [epics, setEpics] = useState<EpicItem[]>([])
  const [epicProgress, setEpicProgress] = useState<Record<string, { total: number; done: number }>>({})
  const [filterText, setFilterText] = useState('')
  const [filterEpic, setFilterEpic] = useState<string>('all')
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())
  const [subtasks, setSubtasks] = useState<Record<string, TaskItem[]>>({})

  const loadData = useCallback(async () => {
    const [taskList, epicList] = await Promise.all([
      window.api.task.list({ projectId: project.id }),
      window.api.epic.list(project.id)
    ])
    setTasks(taskList as TaskItem[])
    setEpics(epicList as EpicItem[])

    const progress: Record<string, { total: number; done: number }> = {}
    for (const epic of epicList as EpicItem[]) {
      progress[epic.id] = await window.api.epic.progress(epic.id)
    }
    setEpicProgress(progress)
  }, [project.id])

  // Load on mount + poll for file watcher changes
  useEffect(() => {
    if (!visible) return
    let disposed = false

    loadData()

    // Poll every 3s to pick up file watcher changes
    const interval = setInterval(() => {
      if (!disposed) loadData()
    }, 3000)

    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [visible, project.id, loadData])

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

  // Filter: text + epic, root tasks only
  const rootTasks = tasks.filter((t) => !t.parentTaskId)
  const filtered = rootTasks.filter((t) => {
    if (filterText && !t.title.toLowerCase().includes(filterText.toLowerCase())) return false
    if (filterEpic !== 'all') {
      if (filterEpic === 'none' && t.epicId) return false
      if (filterEpic !== 'none' && t.epicId !== filterEpic) return false
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
        {epics.length > 0 && (
          <select
            className="deck-sidebar-input deck-kanban-epic-filter"
            value={filterEpic}
            onChange={(e) => setFilterEpic(e.target.value)}
          >
            <option value="all">All epics</option>
            <option value="none">No epic</option>
            {epics.map((e) => (
              <option key={e.id} value={e.id}>{e.title}</option>
            ))}
          </select>
        )}
        <button className="deck-sidebar-btn" onClick={loadData} title="Refresh">
          ↻
        </button>
      </div>

      {/* Epic progress bar */}
      {epics.length > 0 && (
        <div className="deck-epic-bar">
          {epics.map((epic) => {
            const prog = epicProgress[epic.id] || { total: 0, done: 0 }
            const pct = prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0
            return (
              <div key={epic.id} className="deck-epic-chip">
                <span className="deck-epic-chip-title">{epic.title}</span>
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
                  const epic = task.epicId ? epics.find((e) => e.id === task.epicId) : null
                  const isExpanded = expandedCards.has(task.id)
                  const subs = subtasks[task.id] || []
                  const hasSubtasks = tasks.some((t) => t.parentTaskId === task.id)

                  return (
                    <div key={task.id} className="deck-kanban-card">
                      <div className="deck-kanban-card-header">
                        <span className="deck-kanban-card-id">{task.id}</span>
                        {task.priority && (
                          <span className={`deck-kanban-badge deck-kanban-badge--${task.priority}`}>
                            {task.priority}
                          </span>
                        )}
                        {epic && (
                          <span className="deck-kanban-badge deck-kanban-badge--epic">
                            {epic.title}
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
    </div>
  )
}

export default KanbanBoard
