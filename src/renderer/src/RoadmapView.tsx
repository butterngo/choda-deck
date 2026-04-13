import { useEffect, useState, useCallback } from 'react'
import type { SpikeProject } from '../../preload/index'

interface TaskItem {
  id: string
  title: string
  status: string
  priority: string | null
  epicId: string | null
}

interface EpicItem {
  id: string
  title: string
  status: string
}

interface RoadmapViewProps {
  project: SpikeProject
  visible: boolean
}

function RoadmapView({ project, visible }: RoadmapViewProps): React.JSX.Element {
  const [epics, setEpics] = useState<EpicItem[]>([])
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [epicProgress, setEpicProgress] = useState<Record<string, { total: number; done: number }>>({})
  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set())

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

  useEffect(() => {
    if (!visible) return
    let disposed = false
    loadData()
    const interval = setInterval(() => { if (!disposed) loadData() }, 5000)
    return () => { disposed = true; clearInterval(interval) }
  }, [visible, project.id, loadData])

  function toggleEpic(epicId: string): void {
    setExpandedEpics((prev) => {
      const next = new Set(prev)
      if (next.has(epicId)) next.delete(epicId)
      else next.add(epicId)
      return next
    })
  }

  // Tasks without epic
  const unassigned = tasks.filter((t) => !t.epicId)
  const statusCounts = (list: TaskItem[]): Record<string, number> => {
    const counts: Record<string, number> = {}
    for (const t of list) {
      counts[t.status] = (counts[t.status] || 0) + 1
    }
    return counts
  }

  return (
    <div className="deck-roadmap">
      <div className="deck-roadmap-header">
        <span className="deck-roadmap-title">Roadmap — {project.id}</span>
        <button className="deck-sidebar-btn" onClick={loadData} title="Refresh">↻</button>
      </div>

      {epics.length === 0 && unassigned.length === 0 && (
        <div className="deck-plugin-empty">No epics or tasks. Create tasks via AI in the terminal.</div>
      )}

      {epics.map((epic) => {
        const prog = epicProgress[epic.id] || { total: 0, done: 0 }
        const pct = prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0
        const isExpanded = expandedEpics.has(epic.id)
        const epicTasks = tasks.filter((t) => t.epicId === epic.id)
        const counts = statusCounts(epicTasks)

        return (
          <div key={epic.id} className="deck-roadmap-epic">
            <div className="deck-roadmap-epic-header" onClick={() => toggleEpic(epic.id)}>
              <span className="deck-roadmap-expand">{isExpanded ? '▾' : '▸'}</span>
              <span className="deck-roadmap-epic-title">{epic.title}</span>
              <div className="deck-roadmap-progress">
                <div className="deck-roadmap-bar">
                  <div className="deck-roadmap-bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="deck-roadmap-pct">{pct}%</span>
              </div>
              <div className="deck-roadmap-counts">
                {counts['TODO'] && <span className="deck-roadmap-count deck-roadmap-count--todo">{counts['TODO']} todo</span>}
                {counts['READY'] && <span className="deck-roadmap-count deck-roadmap-count--ready">{counts['READY']} ready</span>}
                {counts['IN-PROGRESS'] && <span className="deck-roadmap-count deck-roadmap-count--ip">{counts['IN-PROGRESS']} wip</span>}
                {counts['DONE'] && <span className="deck-roadmap-count deck-roadmap-count--done">{counts['DONE']} done</span>}
              </div>
            </div>

            {isExpanded && (
              <div className="deck-roadmap-tasks">
                {epicTasks.map((task) => (
                  <div key={task.id} className="deck-roadmap-task">
                    <span className={`deck-dot ${task.status === 'DONE' ? 'deck-dot--green' : task.status === 'IN-PROGRESS' ? 'deck-dot--blue' : 'deck-dot--grey'}`} />
                    <span className="deck-roadmap-task-id">{task.id}</span>
                    <span className="deck-roadmap-task-title">{task.title}</span>
                    {task.priority && (
                      <span className={`deck-kanban-badge deck-kanban-badge--${task.priority}`}>{task.priority}</span>
                    )}
                    <span className="deck-roadmap-task-status">{task.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {unassigned.length > 0 && (
        <div className="deck-roadmap-epic">
          <div className="deck-roadmap-epic-header" onClick={() => toggleEpic('__unassigned__')}>
            <span className="deck-roadmap-expand">{expandedEpics.has('__unassigned__') ? '▾' : '▸'}</span>
            <span className="deck-roadmap-epic-title deck-roadmap-epic-title--muted">Unassigned</span>
            <span className="deck-roadmap-pct">{unassigned.length} tasks</span>
          </div>
          {expandedEpics.has('__unassigned__') && (
            <div className="deck-roadmap-tasks">
              {unassigned.map((task) => (
                <div key={task.id} className="deck-roadmap-task">
                  <span className={`deck-dot ${task.status === 'DONE' ? 'deck-dot--green' : task.status === 'IN-PROGRESS' ? 'deck-dot--blue' : 'deck-dot--grey'}`} />
                  <span className="deck-roadmap-task-id">{task.id}</span>
                  <span className="deck-roadmap-task-title">{task.title}</span>
                  <span className="deck-roadmap-task-status">{task.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default RoadmapView
