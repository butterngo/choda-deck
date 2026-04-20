import type {
  PlannerPlan,
  PlanFile,
  PlanStep,
  PlanRisk,
  PlanDependency
} from '../../../core/harness/plan-types'
import type { PipelineState } from '../../../core/harness/pipeline-state'

interface PlanViewerProps {
  plan: PlannerPlan
  state: PipelineState
}

const EMPTY = '—'

function ActionBadge({ action }: { action: PlanFile['action'] }): React.JSX.Element {
  return <span className={`deck-plan-action deck-plan-action--${action}`}>{action}</span>
}

function FilesPanel({ files }: { files: PlanFile[] | undefined }): React.JSX.Element {
  if (!files || files.length === 0) {
    return <div className="deck-plan-empty">{EMPTY}</div>
  }
  return (
    <table className="deck-plan-table">
      <thead>
        <tr>
          <th>Path</th>
          <th>Action</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        {files.map((f, i) => (
          <tr key={`${f.path}-${i}`}>
            <td className="deck-plan-path">{f.path}</td>
            <td>
              <ActionBadge action={f.action} />
            </td>
            <td>{f.why || EMPTY}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function StepsPanel({ steps }: { steps: PlanStep[] | undefined }): React.JSX.Element {
  if (!steps || steps.length === 0) {
    return <div className="deck-plan-empty">{EMPTY}</div>
  }
  const ordered = [...steps].sort((a, b) => a.n - b.n)
  return (
    <ol className="deck-plan-steps">
      {ordered.map((s, i) => (
        <li key={`${s.n}-${i}`}>
          <div className="deck-plan-step-title">
            <span className="deck-plan-step-n">{s.n}.</span> {s.title || EMPTY}
          </div>
          {s.detail && <div className="deck-plan-step-detail">{s.detail}</div>}
        </li>
      ))}
    </ol>
  )
}

function RisksPanel({ risks }: { risks: PlanRisk[] | undefined }): React.JSX.Element {
  if (!risks || risks.length === 0) {
    return <div className="deck-plan-empty">{EMPTY}</div>
  }
  return (
    <div className="deck-plan-cards">
      {risks.map((r, i) => (
        <div key={i} className="deck-plan-card">
          <div className="deck-plan-card-title">⚠ {r.what || EMPTY}</div>
          <div className="deck-plan-card-body">{r.mitigation || EMPTY}</div>
        </div>
      ))}
    </div>
  )
}

function DependenciesPanel({
  dependencies
}: {
  dependencies: PlanDependency[] | undefined
}): React.JSX.Element {
  if (!dependencies || dependencies.length === 0) {
    return <div className="deck-plan-empty">{EMPTY}</div>
  }
  return (
    <table className="deck-plan-table">
      <thead>
        <tr>
          <th>Kind</th>
          <th>Ref</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        {dependencies.map((d, i) => (
          <tr key={`${d.ref}-${i}`}>
            <td>
              <span className={`deck-plan-dep-kind deck-plan-dep-kind--${d.kind}`}>
                {d.kind}
              </span>
            </td>
            <td className="deck-plan-path">{d.ref}</td>
            <td>{d.why || EMPTY}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function MetadataPanel({ state }: { state: PipelineState }): React.JSX.Element {
  return (
    <div className="deck-plan-meta">
      <div>
        <span className="deck-plan-meta-label">Task</span>
        <span>{state.taskId}</span>
      </div>
      <div>
        <span className="deck-plan-meta-label">Stage</span>
        <span>{state.stage}</span>
      </div>
      <div>
        <span className="deck-plan-meta-label">Status</span>
        <span>{state.stageStatus ?? EMPTY}</span>
      </div>
      <div>
        <span className="deck-plan-meta-label">Iteration</span>
        <span>{state.currentIteration}</span>
      </div>
      <div>
        <span className="deck-plan-meta-label">Evaluator</span>
        <span>{state.needsEvaluator ? 'on' : 'off'}</span>
      </div>
    </div>
  )
}

function PlanViewer({ plan, state }: PlanViewerProps): React.JSX.Element {
  return (
    <div className="deck-plan-viewer">
      <MetadataPanel state={state} />
      <section className="deck-plan-section">
        <h3 className="deck-plan-heading">Files</h3>
        <FilesPanel files={plan.files} />
      </section>
      <section className="deck-plan-section">
        <h3 className="deck-plan-heading">Steps</h3>
        <StepsPanel steps={plan.steps} />
      </section>
      <section className="deck-plan-section">
        <h3 className="deck-plan-heading">Risks</h3>
        <RisksPanel risks={plan.risks} />
      </section>
      <section className="deck-plan-section">
        <h3 className="deck-plan-heading">Dependencies</h3>
        <DependenciesPanel dependencies={plan.dependencies} />
      </section>
    </div>
  )
}

export default PlanViewer
