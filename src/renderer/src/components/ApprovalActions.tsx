import { useState } from 'react'

interface ApprovalActionsProps {
  disabled: boolean
  onApprove: () => Promise<void>
  onReject: (feedback: string) => Promise<void>
  onAbort: () => Promise<void>
}

function ApprovalActions({
  disabled,
  onApprove,
  onReject,
  onAbort
}: ApprovalActionsProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [showReject, setShowReject] = useState(false)
  const [showAbort, setShowAbort] = useState(false)
  const [feedback, setFeedback] = useState('')

  async function handleApprove(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await onApprove()
    } finally {
      setBusy(false)
    }
  }

  async function handleRejectConfirm(): Promise<void> {
    const text = feedback.trim()
    if (busy || text.length === 0) return
    setBusy(true)
    try {
      await onReject(text)
      setShowReject(false)
      setFeedback('')
    } finally {
      setBusy(false)
    }
  }

  async function handleAbortConfirm(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await onAbort()
      setShowAbort(false)
    } finally {
      setBusy(false)
    }
  }

  const approvalDisabled = disabled || busy

  return (
    <div className="deck-approval-actions">
      <button
        className="deck-approval-btn deck-approval-btn--approve"
        onClick={handleApprove}
        disabled={approvalDisabled}
      >
        Approve
      </button>
      <button
        className="deck-approval-btn deck-approval-btn--reject"
        onClick={() => setShowReject(true)}
        disabled={approvalDisabled}
      >
        Reject
      </button>
      <button
        className="deck-approval-btn deck-approval-btn--abort"
        onClick={() => setShowAbort(true)}
        disabled={approvalDisabled}
      >
        Abort
      </button>

      {showReject && (
        <div
          className="deck-modal-overlay"
          onClick={() => {
            if (busy) return
            setShowReject(false)
            setFeedback('')
          }}
        >
          <div className="deck-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="deck-modal-title">Reject plan</h3>
            <p className="deck-modal-body">
              Feedback (required) — tell the planner what to revise.
            </p>
            <textarea
              className="deck-modal-textarea"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={6}
              disabled={busy}
              autoFocus
            />
            <div className="deck-modal-actions">
              <button
                className="deck-approval-btn"
                onClick={() => {
                  setShowReject(false)
                  setFeedback('')
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="deck-approval-btn deck-approval-btn--reject"
                onClick={handleRejectConfirm}
                disabled={busy || feedback.trim().length === 0}
              >
                Send feedback
              </button>
            </div>
          </div>
        </div>
      )}

      {showAbort && (
        <div
          className="deck-modal-overlay"
          onClick={() => {
            if (!busy) setShowAbort(false)
          }}
        >
          <div className="deck-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="deck-modal-title">Abort pipeline?</h3>
            <p className="deck-modal-body">
              This ends the session permanently. The current plan will be discarded.
            </p>
            <div className="deck-modal-actions">
              <button
                className="deck-approval-btn"
                onClick={() => setShowAbort(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="deck-approval-btn deck-approval-btn--abort"
                onClick={handleAbortConfirm}
                disabled={busy}
              >
                Confirm abort
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ApprovalActions
