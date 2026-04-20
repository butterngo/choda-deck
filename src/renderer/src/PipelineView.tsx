import PlanViewer from './components/PlanViewer'
import ApprovalActions from './components/ApprovalActions'
import { FIXTURE_PLAN, FIXTURE_PIPELINE_STATE } from './__fixtures__/plan-fixture'
import type { PipelineStageStatus } from '../../core/harness/pipeline-state'

interface PipelineViewProps {
  visible: boolean
}

function statusLabel(status: PipelineStageStatus | null): string {
  if (status === 'running') return 'Running…'
  if (status === 'ready') return 'Ready for review'
  if (status === 'approved') return 'Approved'
  if (status === 'rejected') return 'Rejected — awaiting re-run'
  return 'Idle'
}

function PipelineView({ visible }: PipelineViewProps): React.JSX.Element {
  // Phase 1: fixture data. Phase 2 will fetch via window.api.pipeline.*.
  const state = FIXTURE_PIPELINE_STATE
  const plan = FIXTURE_PLAN

  async function handleApprove(): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[PipelineView] approve (mock)', state.sessionId)
  }

  async function handleReject(feedback: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[PipelineView] reject (mock)', state.sessionId, feedback)
  }

  async function handleAbort(): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[PipelineView] abort (mock)', state.sessionId)
  }

  const isActionable = state.stageStatus === 'ready'
  const statusKey = state.stageStatus ?? 'idle'

  return (
    <div className={`deck-pipeline-view${visible ? '' : ' deck-terminal--hidden'}`}>
      <header className="deck-pipeline-header">
        <div className="deck-pipeline-title">
          <h2>Pipeline — {state.stage.toUpperCase()}</h2>
          <span className={`deck-pipeline-status deck-pipeline-status--${statusKey}`}>
            {statusLabel(state.stageStatus)}
          </span>
        </div>
        <ApprovalActions
          disabled={!isActionable}
          onApprove={handleApprove}
          onReject={handleReject}
          onAbort={handleAbort}
        />
      </header>
      <PlanViewer plan={plan} state={state} />
    </div>
  )
}

export default PipelineView
