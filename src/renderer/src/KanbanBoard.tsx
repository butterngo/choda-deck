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
}

interface KanbanBoardProps {
  project: SpikeProject
  visible: boolean
}

function KanbanBoard({ project, visible }: KanbanBoardProps): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [dragId, setDragId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [filterText, setFilterText] = useState('')

  useEffect(() => {
    if (!visible) return
    let disposed = false

    window.api.task.list({ projectId: project.id }).then((list) => {
      if (!disposed) setTasks(list as TaskItem[])
    })

    return () => { disposed = true }
  }, [visible, project.id])

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
      status: 'TODO'
    }) as TaskItem
    setTasks((prev) => [task, ...prev])
    setNewTitle('')
    setShowCreate(false)
  }

  async function handleDelete(id: string): Promise<void> {
    await window.api.task.delete(id)
    setTasks((prev) => prev.filter((t) => t.id !== id))
  }

  const filtered = filterText
    ? tasks.filter((t) => t.title.toLowerCase().includes(filterText.toLowerCase()))
    : tasks

  return (
    <div className="deck-kanban">
      <div className="deck-kanban-toolbar">
        <input
          className="deck-sidebar-input deck-kanban-search"
          placeholder="Filter tasks..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <button
          className="deck-sidebar-btn deck-sidebar-btn--ok"
          onClick={() => setShowCreate(true)}
        >
          + Task
        </button>
      </div>

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
          <div className="deck-sidebar-form-actions">
            <button className="deck-sidebar-btn deck-sidebar-btn--ok" onClick={handleCreate}>Create</button>
            <button className="deck-sidebar-btn" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </div>
      )}

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
                {columnTasks.map((task) => (
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
                      <button
                        className="deck-sidebar-remove-btn"
                        onClick={() => handleDelete(task.id)}
                      >
                        x
                      </button>
                    </div>
                    <div className="deck-kanban-card-title">{task.title}</div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default KanbanBoard
