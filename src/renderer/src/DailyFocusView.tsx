import { useEffect, useState, useCallback } from 'react'

interface TaskItem {
  id: string
  title: string
  status: string
  priority: string | null
  projectId: string
  pinned: boolean
  dueDate: string | null
}

interface DailyFocusViewProps {
  visible: boolean
}

function DailyFocusView({ visible }: DailyFocusViewProps): React.JSX.Element {
  const [pinnedTasks, setPinnedTasks] = useState<TaskItem[]>([])
  const [dueTasks, setDueTasks] = useState<TaskItem[]>([])
  const [inProgressTasks, setInProgressTasks] = useState<TaskItem[]>([])

  const today = new Date().toISOString().split('T')[0]

  const loadData = useCallback(async () => {
    const [pinned, due, wip] = await Promise.all([
      window.api.task.pinned(),
      window.api.task.due(today),
      window.api.task.list({ status: 'IN-PROGRESS' })
    ])
    setPinnedTasks(pinned as TaskItem[])
    setDueTasks((due as TaskItem[]).filter(t => !t.pinned)) // avoid duplicates
    setInProgressTasks(wip as TaskItem[])
  }, [today])

  useEffect(() => {
    if (!visible) return
    loadData()
    const cleanup = window.api.task.onChanged(() => loadData())
    return () => cleanup()
  }, [visible, loadData])

  function renderTask(task: TaskItem): React.JSX.Element {
    return (
      <div key={task.id} className="deck-focus-task">
        <span className={`deck-dot ${task.status === 'DONE' ? 'deck-dot--green' : task.status === 'IN-PROGRESS' ? 'deck-dot--blue' : 'deck-dot--grey'}`} />
        <span className="deck-focus-task-id">{task.id}</span>
        <span className="deck-focus-task-title">{task.title}</span>
        {task.priority && (
          <span className={`deck-kanban-badge deck-kanban-badge--${task.priority}`}>{task.priority}</span>
        )}
        <span className="deck-focus-task-project">{task.projectId}</span>
        <span className="deck-focus-task-status">{task.status}</span>
      </div>
    )
  }

  const isEmpty = pinnedTasks.length === 0 && dueTasks.length === 0 && inProgressTasks.length === 0

  return (
    <div className="deck-focus">
      <div className="deck-focus-header">
        <span className="deck-focus-title">Daily Focus — {today}</span>
        <button className="deck-sidebar-btn" onClick={loadData} title="Refresh">↻</button>
      </div>

      {isEmpty && (
        <div className="deck-plugin-empty">
          No tasks for today. Pin tasks or set due dates via AI in the terminal.
        </div>
      )}

      {pinnedTasks.length > 0 && (
        <div className="deck-focus-section">
          <div className="deck-focus-section-title">Pinned</div>
          {pinnedTasks.map(renderTask)}
        </div>
      )}

      {dueTasks.length > 0 && (
        <div className="deck-focus-section">
          <div className="deck-focus-section-title">Due today</div>
          {dueTasks.map(renderTask)}
        </div>
      )}

      {inProgressTasks.length > 0 && (
        <div className="deck-focus-section">
          <div className="deck-focus-section-title">In Progress</div>
          {inProgressTasks.map(renderTask)}
        </div>
      )}
    </div>
  )
}

export default DailyFocusView
