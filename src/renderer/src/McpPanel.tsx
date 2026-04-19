import { useEffect, useState } from 'react'

interface McpStatus {
  registered: boolean
  path?: string
}

function McpPanel(): React.JSX.Element {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let mounted = true
    window.api.mcp.status().then((s) => {
      if (mounted) setStatus(s)
    })
    return () => {
      mounted = false
    }
  }, [reloadKey])

  async function handleUnregister(): Promise<void> {
    if (busy) return
    const ok = confirm(
      'Remove choda-tasks MCP entry from ~/.claude.json? Claude Code will no longer see the MCP tools until the next launch of Choda Deck re-registers it.'
    )
    if (!ok) return
    setBusy(true)
    setMessage(null)
    const res = await window.api.mcp.unregister()
    setBusy(false)
    if (res.ok) {
      setMessage('Unregistered')
      setReloadKey((k) => k + 1)
    } else {
      setMessage(`Failed: ${res.error}`)
    }
  }

  return (
    <div className="deck-mcp">
      <div className="deck-mcp-header">
        <span className="deck-mcp-title">Claude Code MCP</span>
      </div>
      {status === null ? (
        <div className="deck-mcp-empty">Loading…</div>
      ) : status.registered ? (
        <div className="deck-mcp-row">
          <div className="deck-mcp-row-main">
            <span className="deck-mcp-row-label">
              Registered as <code>choda-tasks</code>
            </span>
            <span className="deck-mcp-row-path" title={status.path}>
              {status.path}
            </span>
          </div>
          <button className="deck-sidebar-btn" disabled={busy} onClick={handleUnregister}>
            Unregister
          </button>
        </div>
      ) : (
        <div className="deck-mcp-empty">
          Not registered. Either ~/.claude.json is missing, or Choda Deck has not written an entry
          yet.
        </div>
      )}
      {message && <div className="deck-mcp-status">{message}</div>}
    </div>
  )
}

export default McpPanel
