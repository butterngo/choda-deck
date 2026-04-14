import { useEffect, useState, useCallback } from 'react'

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
  startDate: string | null
  completedDate: string | null
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

function TaskCount({ progress }: { progress: Progress }): React.JSX.Element {
  return (
    <span className="deck-roadmap-task-count">
      {progress.done}/{progress.total} tasks
    </span>
  )
}

function RoadmapView({ projectId, visible }: RoadmapViewProps): React.JSX.Element {
  const [phases, setPhases] = useState<PhaseItem[]>([])
  const [features, setFeatures] = useState<FeatureItem[]>([])
  const [phaseProgress, setPhaseProgress] = useState<Record<string, Progress>>({})
  const [featureProgress, setFeatureProgress] = useState<Record<string, Progress>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showAddPhase, setShowAddPhase] = useState(false)
  const [newPhaseTitle, setNewPhaseTitle] = useState('')
  const [addFeaturePhaseId, setAddFeaturePhaseId] = useState<string | null>(null)
  const [newFeatureTitle, setNewFeatureTitle] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const loadData = useCallback(async () => {
    const [phaseList, featureList] = await Promise.all([
      window.api.phase.list(projectId),
      window.api.feature.list(projectId)
    ])
    setPhases(phaseList as PhaseItem[])
    setFeatures(featureList as FeatureItem[])

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
  }, [projectId])

  useEffect(() => {
    if (!visible) return
    loadData()
    const cleanup = window.api.task.onChanged(() => loadData())
    return () => cleanup()
  }, [visible, projectId, loadData])

  // ── Handlers ────────────────────────────────────────────────────────────

  async function handleAddPhase(): Promise<void> {
    if (!newPhaseTitle.trim()) return
    await window.api.phase.create({ projectId, title: newPhaseTitle.trim(), position: phases.length })
    setNewPhaseTitle('')
    setShowAddPhase(false)
    loadData()
  }

  async function handleDeletePhase(phaseId: string, title: string): Promise<void> {
    const prog = phaseProgress[phaseId]
    const msg = prog && prog.total > 0
      ? `Delete "${title}" and its ${prog.total} tasks?`
      : `Delete "${title}"?`
    if (!confirm(msg)) return
    await window.api.phase.delete(phaseId, true)
    loadData()
  }

  async function handleMovePhase(phaseId: string, direction: 'up' | 'down'): Promise<void> {
    const idx = phases.findIndex(p => p.id === phaseId)
    if (idx < 0) return
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= phases.length) return
    await window.api.phase.update(phases[idx].id, { position: swapIdx })
    await window.api.phase.update(phases[swapIdx].id, { position: idx })
    loadData()
  }

  async function handleSetStartDate(phaseId: string, date: string): Promise<void> {
    await window.api.phase.update(phaseId, { startDate: date || null })
    loadData()
  }

  async function handleAddFeature(phaseId: string): Promise<void> {
    if (!newFeatureTitle.trim()) return
    await window.api.feature.create({ projectId, phaseId, title: newFeatureTitle.trim() })
    setNewFeatureTitle('')
    setAddFeaturePhaseId(null)
    loadData()
  }

  async function handleDeleteFeature(featureId: string, title: string): Promise<void> {
    const prog = featureProgress[featureId]
    const msg = prog && prog.total > 0
      ? `Delete "${title}" and its ${prog.total} tasks?`
      : `Delete "${title}"?`
    if (!confirm(msg)) return
    // Delete tasks in feature first
    const tasks = await window.api.task.list({ featureId }) as Array<{ id: string }>
    for (const t of tasks) await window.api.task.delete(t.id)
    await window.api.feature.delete(featureId)
    loadData()
  }

  function toggle(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const featuresByPhase = (phaseId: string): FeatureItem[] =>
    features.filter(f => f.phaseId === phaseId)

  // ── Render ──────────────────────────────────────────────────────────────

  function handleFeatureClick(feat: FeatureItem): void {
    // Dispatch events to switch to Kanban tab + filter by feature
    window.dispatchEvent(new CustomEvent('deck:filter-feature', {
      detail: { featureId: feat.id, phaseId: feat.phaseId }
    }))
    window.dispatchEvent(new CustomEvent('deck:switch-tab', {
      detail: { tab: 'tasks' }
    }))
  }

  function renderFeature(feat: FeatureItem): React.JSX.Element {
    const prog = featureProgress[feat.id] || { total: 0, done: 0, inProgress: 0, status: 'planned', percent: 0 }

    return (
      <div key={feat.id} className="deck-roadmap-feature" onClick={() => handleFeatureClick(feat)} style={{ cursor: 'pointer' }}>
        <span className="deck-roadmap-feature-title">{feat.title}</span>
        <TaskCount progress={prog} />
        <ProgressBar progress={prog} />
        <StatusBadge status={prog.status} />
        <button
          className="deck-roadmap-delete-btn"
          onClick={(e) => { e.stopPropagation(); handleDeleteFeature(feat.id, feat.title) }}
          title="Delete feature"
        >
          x
        </button>
      </div>
    )
  }

  function renderPhase(phase: PhaseItem): React.JSX.Element {
    const prog = phaseProgress[phase.id] || { total: 0, done: 0, inProgress: 0, status: 'planned', percent: 0 }
    const isExp = expanded.has(phase.id)
    const pFeatures = featuresByPhase(phase.id)

    return (
      <div key={phase.id} className="deck-roadmap-phase">
        <div className="deck-roadmap-phase-header" onClick={() => toggle(phase.id)}>
          <span className="deck-roadmap-expand">{isExp ? '▾' : '▸'}</span>
          <div className="deck-roadmap-sort-btns" onClick={(e) => e.stopPropagation()}>
            <button
              className="deck-roadmap-sort-btn"
              disabled={phases.indexOf(phase) === 0}
              onClick={() => handleMovePhase(phase.id, 'up')}
              title="Move up"
            >&#9650;</button>
            <button
              className="deck-roadmap-sort-btn"
              disabled={phases.indexOf(phase) === phases.length - 1}
              onClick={() => handleMovePhase(phase.id, 'down')}
              title="Move down"
            >&#9660;</button>
          </div>
          <span className="deck-roadmap-phase-title">{phase.title}</span>
          <input
            type="date"
            className="deck-roadmap-date-input"
            value={phase.startDate || ''}
            onChange={(e) => handleSetStartDate(phase.id, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            title={phase.startDate ? 'Start date' : 'Set start date to activate'}
          />
          {phase.completedDate && (
            <span className="deck-roadmap-completed-date" title="Completed date">
              ~ {phase.completedDate}
            </span>
          )}
          <TaskCount progress={prog} />
          <ProgressBar progress={prog} />
          <StatusBadge status={prog.status} />
          <button
            className="deck-roadmap-delete-btn"
            onClick={(e) => { e.stopPropagation(); handleDeletePhase(phase.id, phase.title) }}
            title="Delete phase"
          >
            x
          </button>
        </div>
        {isExp && (
          <div className="deck-roadmap-phase-body">
            {pFeatures.map(renderFeature)}
            {addFeaturePhaseId === phase.id ? (
              <div className="deck-roadmap-inline-form">
                <input
                  className="deck-sidebar-input"
                  placeholder="Feature title..."
                  value={newFeatureTitle}
                  onChange={(e) => setNewFeatureTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddFeature(phase.id); if (e.key === 'Escape') setAddFeaturePhaseId(null) }}
                  autoFocus
                />
                <button className="deck-sidebar-btn deck-sidebar-btn--ok" onClick={() => handleAddFeature(phase.id)}>Create</button>
                <button className="deck-sidebar-btn" onClick={() => setAddFeaturePhaseId(null)}>Cancel</button>
              </div>
            ) : (
              <button
                className="deck-roadmap-add-btn"
                onClick={() => setAddFeaturePhaseId(phase.id)}
              >
                + Add Feature
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const filteredPhases = statusFilter === 'all'
    ? phases
    : phases.filter((ph) => {
        const prog = phaseProgress[ph.id]
        return prog && prog.status === statusFilter
      })

  return (
    <div className="deck-roadmap">
      <div className="deck-roadmap-header">
        <span className="deck-roadmap-title">Roadmap</span>
        <div className="deck-roadmap-filters">
          {['all', 'planned', 'active', 'completed'].map((s) => (
            <button
              key={s}
              className={`deck-roadmap-filter-btn${statusFilter === s ? ' deck-roadmap-filter-btn--active' : ''}`}
              onClick={() => setStatusFilter(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <button className="deck-sidebar-btn" onClick={() => setShowAddPhase(true)} title="Add phase">+</button>
        <button className="deck-sidebar-btn" onClick={loadData} title="Refresh">↻</button>
      </div>

      {showAddPhase && (
        <div className="deck-roadmap-inline-form">
          <input
            className="deck-sidebar-input"
            placeholder="Phase title..."
            value={newPhaseTitle}
            onChange={(e) => setNewPhaseTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddPhase(); if (e.key === 'Escape') setShowAddPhase(false) }}
            autoFocus
          />
          <button className="deck-sidebar-btn deck-sidebar-btn--ok" onClick={handleAddPhase}>Create</button>
          <button className="deck-sidebar-btn" onClick={() => setShowAddPhase(false)}>Cancel</button>
        </div>
      )}

      {phases.length === 0 && (
        <div className="deck-plugin-empty">No phases yet. Click + to create one.</div>
      )}

      {filteredPhases.map(renderPhase)}
    </div>
  )
}

export default RoadmapView
