import { useEffect, useState } from 'react'
import PlanViewer from './components/PlanViewer'
import ApprovalActions from './components/ApprovalActions'
import { FIXTURE_PLAN, FIXTURE_PIPELINE_STATE } from './__fixtures__/plan-fixture'
import type { PipelineState, PipelineStageStatus } from '../../core/harness/pipeline-state'
import type { PlannerPlan } from '../../core/harness/plan-types'

interface PipelineViewProps {
  visible: boolean
  // null/undefined → demo mode (fixture). A real session id switches to IPC.
  sessionId?: string | null
}

function statusLabel(status: PipelineStageStatus | null): string {
  if (status === 'running') return 'Running…'
  if (status === 'ready') return 'Ready for review'
  if (status === 'approved') return 'Approved'
  if (status === 'rejected') return 'Rejected — awaiting re-run'
  return 'Idle'
}

function PipelineView({ visible, sessionId }: PipelineViewProps): React.JSX.Element {
  const demo = !sessionId
  const [state, setState] = useState<PipelineState | null>(demo ? FIXTURE_PIPELINE_STATE : null)
  const [plan, setPlan] = useState<PlannerPlan | null>(demo ? FIXTURE_PLAN : null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) {
      setState(FIXTURE_PIPELINE_STATE)
      setPlan(FIXTURE_PLAN)
      setError(null)
      return
    }

    let disposed = false
    setError(null)

    Promise.all([
      window.api.pipeline.getState(sessionId),
      window.api.pipeline.readPlan(sessionId).catch(() => null)
    ])
      .then(([nextState, nextPlan]) => {
        if (disposed) return
        setState(nextState)
        setPlan(nextPlan)
      })
      .catch((err: unknown) => {
        if (disposed) return
        setError(err instanceof Error ? err.message : String(err))
      })

    const unsubscribe = window.api.pipeline.onStageChange(sessionId, (next) => {
      if (!disposed) setState(next)
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [sessionId])

  async function handleApprove(): Promise<void> {
    if (!sessionId) return
    try {
      const next = await window.api.pipeline.approve(sessionId)
      setState(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleReject(feedback: string): Promise<void> {
    if (!sessionId) return
    try {
      const next = await window.api.pipeline.reject(sessionId, feedback)
      setState(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleAbort(): Promise<void> {
    if (!sessionId) return
    try {
      const next = await window.api.pipeline.abort(sessionId)
      setState(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const rootClass = `deck-pipeline-view${visible ? '' : ' deck-terminal--hidden'}`

  if (error) {
    return (
      <div className={rootClass}>
        <div className="deck-pipeline-error">Pipeline error: {error}</div>
      </div>
    )
  }

  if (!state || !plan) {
    return (
      <div className={rootClass}>
        <div className="deck-pipeline-empty-state">Loading pipeline…</div>
      </div>
    )
  }

  const isActionable = state.stageStatus === 'ready' && !demo
  const statusKey = state.stageStatus ?? 'idle'

  return (
    <div className={rootClass}>
      {demo && (
        <div className="deck-pipeline-demo-banner">
          Demo mode — fixture data. Actions disabled until a real pipeline session is wired.
        </div>
      )}
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
