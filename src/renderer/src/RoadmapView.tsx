import { useEffect, useState, useCallback } from 'react'

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
  featureId: string | null
}

interface FeatureItem {
  id: string
  title: string
  phaseId: string | null
  priority: string | null
}

interface PhaseItem {
  id: string
  title: string
  status: string
  position: number
  targetDate: string | null
}

interface Progress {
  total: number
  done: number
  inProgress: number
  status: string
  percent: number
}

interface RoadmapViewProps {
  projectId: string
  visible: boolean
}

function ProgressBar({ progress }: { progress: Progress }): React.JSX.Element {
  return (
    <div className="deck-roadmap-progress">
      <div className="deck-roadmap-bar">
        <div className="deck-roadmap-bar-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <span className="deck-roadmap-pct">{progress.percent}%</span>
    </div>
  )
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const cls = status === 'completed' ? 'deck-roadmap-count--done'
    : status === 'active' ? 'deck-roadmap-count--ip'
    : 'deck-roadmap-count--todo'
  return <span className={`deck-roadmap-count ${cls}`}>{status}</span>
}

function RoadmapView({ projectId, visible }: RoadmapViewProps): React.JSX.Element {
  const [phases, setPhases] = useState<PhaseItem[]>([])
  const [features, setFeatures] = useState<FeatureItem[]>([])
  const [epics, setEpics] = useState<EpicItem[]>([])
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [phaseProgress, setPhaseProgress] = useState<Record<string, Progress>>({})
  const [featureProgress, setFeatureProgress] = useState<Record<string, Progress>>({})
  const [epicProgress, setEpicProgress] = useState<Record<string, Progress>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const loadData = useCallback(async () => {
    const [phaseList, featureList, epicList, taskList] = await Promise.all([
      window.api.phase.list(projectId),
      window.api.feature.list(projectId),
      window.api.epic.list(projectId),
      window.api.task.list({ projectId })
    ])
    setPhases(phaseList as PhaseItem[])
    setFeatures(featureList as FeatureItem[])
    setEpics(epicList as EpicItem[])
    setTasks(taskList as TaskItem[])

    // Load progress for all phases, features, epics
    const pp: Record<string, Progress> = {}
    for (const ph of phaseList as PhaseItem[]) {
      pp[ph.id] = await window.api.phase.progress(ph.id)
    }
    setPhaseProgress(pp)

    const fp: Record<string, Progress> = {}
    for (const f of featureList as FeatureItem[]) {
      fp[f.id] = await window.api.feature.progress(f.id)
    }
    setFeatureProgress(fp)

    const ep: Record<string, Progress> = {}
    for (const e of epicList as EpicItem[]) {
      ep[e.id] = await window.api.epic.progress(e.id)
    }
    setEpicProgress(ep)
  }, [projectId])

  useEffect(() => {
    if (!visible) return
    loadData()
    const cleanup = window.api.task.onChanged(() => loadData())
    return () => cleanup()
  }, [visible, projectId, loadData])

  function toggle(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Group: features by phase, epics by feature, tasks by epic
  const featuresByPhase = (phaseId: string): FeatureItem[] =>
    features.filter(f => f.phaseId === phaseId)
  const epicsByFeature = (featureId: string): EpicItem[] =>
    epics.filter(e => e.featureId === featureId)
  const tasksByEpic = (epicId: string): TaskItem[] =>
    tasks.filter(t => t.epicId === epicId)

  // Unassigned: features without phase, epics without feature, tasks without epic
  const unassignedFeatures = features.filter(f => !f.phaseId)
  const unassignedEpics = epics.filter(e => !e.featureId)
  const unassignedTasks = tasks.filter(t => !t.epicId)

  function renderTask(task: TaskItem): React.JSX.Element {
    return (
      <div key={task.id} className="deck-roadmap-task">
        <span className={`deck-dot ${task.status === 'DONE' ? 'deck-dot--green' : task.status === 'IN-PROGRESS' ? 'deck-dot--blue' : 'deck-dot--grey'}`} />
        <span className="deck-roadmap-task-id">{task.id}</span>
        <span className="deck-roadmap-task-title">{task.title}</span>
        {task.priority && <span className={`deck-kanban-badge deck-kanban-badge--${task.priority}`}>{task.priority}</span>}
        <span className="deck-roadmap-task-status">{task.status}</span>
      </div>
    )
  }

  function renderEpic(epic: EpicItem): React.JSX.Element {
    const prog = epicProgress[epic.id] || { total: 0, done: 0, inProgress: 0, status: 'planned', percent: 0 }
    const isExp = expanded.has(epic.id)
    const eTasks = tasksByEpic(epic.id)

    return (
      <div key={epic.id} className="deck-roadmap-epic deck-roadmap-level--3">
        <div className="deck-roadmap-epic-header" onClick={() => toggle(epic.id)}>
          <span className="deck-roadmap-expand">{isExp ? '▾' : '▸'}</span>
          <span className="deck-roadmap-epic-title">{epic.title}</span>
          <ProgressBar progress={prog} />
          <StatusBadge status={prog.status} />
        </div>
        {isExp && (
          <div className="deck-roadmap-tasks">
            {eTasks.map(renderTask)}
            {eTasks.length === 0 && <div className="deck-roadmap-empty">No tasks</div>}
          </div>
        )}
      </div>
    )
  }

  function renderFeature(feat: FeatureItem): React.JSX.Element {
    const prog = featureProgress[feat.id] || { total: 0, done: 0, inProgress: 0, status: 'planned', percent: 0 }
    const isExp = expanded.has(feat.id)
    const fEpics = epicsByFeature(feat.id)

    return (
      <div key={feat.id} className="deck-roadmap-epic deck-roadmap-level--2">
        <div className="deck-roadmap-epic-header" onClick={() => toggle(feat.id)}>
          <span className="deck-roadmap-expand">{isExp ? '▾' : '▸'}</span>
          <span className="deck-roadmap-epic-title">{feat.title}</span>
          <ProgressBar progress={prog} />
          <StatusBadge status={prog.status} />
        </div>
        {isExp && (
          <div className="deck-roadmap-tasks">
            {fEpics.map(renderEpic)}
            {fEpics.length === 0 && <div className="deck-roadmap-empty">No epics</div>}
          </div>
        )}
      </div>
    )
  }

  function renderPhase(phase: PhaseItem): React.JSX.Element {
    const prog = phaseProgress[phase.id] || { total: 0, done: 0, inProgress: 0, status: 'planned', percent: 0 }
    const isExp = expanded.has(phase.id)
    const pFeatures = featuresByPhase(phase.id)

    return (
      <div key={phase.id} className="deck-roadmap-epic deck-roadmap-level--1">
        <div className="deck-roadmap-epic-header" onClick={() => toggle(phase.id)}>
          <span className="deck-roadmap-expand">{isExp ? '▾' : '▸'}</span>
          <span className="deck-roadmap-epic-title">{phase.title}</span>
          {phase.targetDate && <span className="deck-roadmap-date">{phase.targetDate}</span>}
          <ProgressBar progress={prog} />
          <span className={`deck-roadmap-count ${phase.status === 'closed' ? 'deck-roadmap-count--done' : 'deck-roadmap-count--ip'}`}>
            {phase.status}
          </span>
        </div>
        {isExp && (
          <div className="deck-roadmap-tasks">
            {pFeatures.map(renderFeature)}
            {pFeatures.length === 0 && <div className="deck-roadmap-empty">No features</div>}
          </div>
        )}
      </div>
    )
  }

  const hasData = phases.length > 0 || features.length > 0 || epics.length > 0 || tasks.length > 0

  return (
    <div className="deck-roadmap">
      <div className="deck-roadmap-header">
        <span className="deck-roadmap-title">Roadmap — {projectId}</span>
        <button className="deck-sidebar-btn" onClick={loadData} title="Refresh">↻</button>
      </div>

      {!hasData && (
        <div className="deck-plugin-empty">No phases, features, or tasks. Import from vault first.</div>
      )}

      {phases.map(renderPhase)}

      {unassignedFeatures.length > 0 && (
        <div className="deck-roadmap-epic deck-roadmap-level--2">
          <div className="deck-roadmap-epic-header" onClick={() => toggle('__unassigned-features__')}>
            <span className="deck-roadmap-expand">{expanded.has('__unassigned-features__') ? '▾' : '▸'}</span>
            <span className="deck-roadmap-epic-title deck-roadmap-epic-title--muted">Unassigned Features</span>
            <span className="deck-roadmap-pct">{unassignedFeatures.length}</span>
          </div>
          {expanded.has('__unassigned-features__') && (
            <div className="deck-roadmap-tasks">
              {unassignedFeatures.map(renderFeature)}
            </div>
          )}
        </div>
      )}

      {unassignedEpics.length > 0 && (
        <div className="deck-roadmap-epic deck-roadmap-level--3">
          <div className="deck-roadmap-epic-header" onClick={() => toggle('__unassigned-epics__')}>
            <span className="deck-roadmap-expand">{expanded.has('__unassigned-epics__') ? '▾' : '▸'}</span>
            <span className="deck-roadmap-epic-title deck-roadmap-epic-title--muted">Unassigned Epics</span>
            <span className="deck-roadmap-pct">{unassignedEpics.length}</span>
          </div>
          {expanded.has('__unassigned-epics__') && (
            <div className="deck-roadmap-tasks">
              {unassignedEpics.map(renderEpic)}
            </div>
          )}
        </div>
      )}

      {unassignedTasks.length > 0 && (
        <div className="deck-roadmap-epic">
          <div className="deck-roadmap-epic-header" onClick={() => toggle('__unassigned__')}>
            <span className="deck-roadmap-expand">{expanded.has('__unassigned__') ? '▾' : '▸'}</span>
            <span className="deck-roadmap-epic-title deck-roadmap-epic-title--muted">Unassigned Tasks</span>
            <span className="deck-roadmap-pct">{unassignedTasks.length}</span>
          </div>
          {expanded.has('__unassigned__') && (
            <div className="deck-roadmap-tasks">
              {unassignedTasks.map(renderTask)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default RoadmapView
