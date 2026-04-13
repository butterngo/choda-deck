import { useEffect, useState } from 'react'
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
  const [dragId, setDragId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showCreateEpic, setShowCreateEpic] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newEpicTitle, setNewEpicTitle] = useState('')
  const [newEpicId, setNewEpicId] = useState<string>('')
  const [filterText, setFilterText] = useState('')
  const [filterEpic, setFilterEpic] = useState<string>('all')
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())
  const [subtasks, setSubtasks] = useState<Record<string, TaskItem[]>>({})

  // Load tasks + epics
  useEffect(() => {
    if (!visible) return
    let disposed = false

    async function load(): Promise<void> {
      const [taskList, epicList] = await Promise.all([
        window.api.task.list({ projectId: project.id }),
        window.api.epic.list(project.id)
      ])
      if (disposed) return
      setTasks(taskList as TaskItem[])
      setEpics(epicList as EpicItem[])

      // Load epic progress
      const progress: Record<string, { total: number; done: number }> = {}
      for (const epic of epicList as EpicItem[]) {
        progress[epic.id] = await window.api.epic.progress(epic.id)
      }
      if (!disposed) setEpicProgress(progress)
    }

    load()
    return () => { disposed = true }
  }, [visible, project.id])

  // Load subtasks for expanded card
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

  async function handleDrop(status: string): Promise<void> {
    if (!dragId) return
    await window.api.task.update(dragId, { status })
    setTasks((prev) =>
      prev.map((t) => (t.id === dragId ? { ...t, status } : t))
    )
    setDragId(null)
  }

  async function handleCreate(): Promise<void> {
    const title = newTitle.trim()
    if (!title) return
    const task = await window.api.task.create({
      projectId: project.id,
      title,
      status: 'TODO',
      epicId: newEpicId || undefined
    }) as TaskItem
    setTasks((prev) => [task, ...prev])
    setNewTitle('')
    setNewEpicId('')
    setShowCreate(false)
  }

  async function handleCreateEpic(): Promise<void> {
    const title = newEpicTitle.trim()
    if (!title) return
    const epic = await window.api.epic.create({
      projectId: project.id,
      title
    }) as EpicItem
    setEpics((prev) => [...prev, epic])
    setNewEpicTitle('')
    setShowCreateEpic(false)
  }

  async function handleDelete(id: string): Promise<void> {
    await window.api.task.delete(id)
    setTasks((prev) => prev.filter((t) => t.id !== id))
  }

  async function handleDeleteEpic(id: string): Promise<void> {
    await window.api.epic.delete(id)
    setEpics((prev) => prev.filter((e) => e.id !== id))
    // Tasks unlinked from epic (handled by SQLite)
    setTasks((prev) => prev.map((t) => t.epicId === id ? { ...t, epicId: null } : t))
  }

  // Filter tasks: text + epic
  const rootTasks = tasks.filter((t) => !t.parentTaskId) // only root tasks on board
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
        <button className="deck-sidebar-btn" onClick={() => setShowCreateEpic(true)}>+ Epic</button>
        <button className="deck-sidebar-btn deck-sidebar-btn--ok" onClick={() => setShowCreate(true)}>+ Task</button>
      </div>

      {/* Epic bar */}
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
                <button className="deck-sidebar-remove-btn" onClick={() => handleDeleteEpic(epic.id)}>x</button>
              </div>
            )
          })}
        </div>
      )}

      {/* Create epic form */}
      {showCreateEpic && (
        <div className="deck-kanban-create">
          <input
            className="deck-sidebar-input"
            placeholder="Epic title"
            value={newEpicTitle}
            onChange={(e) => setNewEpicTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateEpic() }}
            autoFocus
          />
          <div className="deck-sidebar-form-actions">
            <button className="deck-sidebar-btn deck-sidebar-btn--ok" onClick={handleCreateEpic}>Create</button>
            <button className="deck-sidebar-btn" onClick={() => setShowCreateEpic(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Create task form */}
      {showCreate && (
        <div className="deck-kanban-create">
          <input
            className="deck-sidebar-input"
            placeholder="Task title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
            autoFocus
          />
          {epics.length > 0 && (
            <select
              className="deck-sidebar-input"
              value={newEpicId}
              onChange={(e) => setNewEpicId(e.target.value)}
            >
              <option value="">No epic</option>
              {epics.map((e) => (
                <option key={e.id} value={e.id}>{e.title}</option>
              ))}
            </select>
          )}
          <div className="deck-sidebar-form-actions">
            <button className="deck-sidebar-btn deck-sidebar-btn--ok" onClick={handleCreate}>Create</button>
            <button className="deck-sidebar-btn" onClick={() => setShowCreate(false)}>Cancel</button>
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
              className="deck-kanban-column"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(status)}
            >
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
                    <div
                      key={task.id}
                      className={`deck-kanban-card${dragId === task.id ? ' deck-kanban-card--dragging' : ''}`}
                      draggable
                      onDragStart={() => setDragId(task.id)}
                      onDragEnd={() => setDragId(null)}
                    >
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
                        <button
                          className="deck-sidebar-remove-btn"
                          onClick={() => handleDelete(task.id)}
                        >
                          x
                        </button>
                      </div>
                      <div className="deck-kanban-card-title">{task.title}</div>

                      {/* Subtask toggle */}
                      {hasSubtasks && (
                        <button
                          className="deck-kanban-subtask-toggle"
                          onClick={() => toggleExpand(task.id)}
                        >
                          {isExpanded ? '▾' : '▸'} subtasks
                        </button>
                      )}

                      {/* Expanded subtasks */}
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
