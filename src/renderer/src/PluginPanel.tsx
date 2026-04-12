import { useEffect, useState } from 'react'
import type { PluginEntry } from '../../preload/index'

interface PluginStatus {
  id: string
  enabled: boolean
  status: string
}

interface PluginPanelProps {
  visible: boolean
  onClose: () => void
}

function PluginPanel({ visible, onClose }: PluginPanelProps): React.JSX.Element | null {
  const [plugins, setPlugins] = useState<PluginEntry[]>([])
  const [statuses, setStatuses] = useState<PluginStatus[]>([])
  const [adding, setAdding] = useState(false)
  const [addId, setAddId] = useState('')
  const [addCommand, setAddCommand] = useState('')
  const [addArgs, setAddArgs] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  // Load plugins + statuses
  useEffect(() => {
    if (!visible) return
    let disposed = false

    async function load(): Promise<void> {
      const [list, stats] = await Promise.all([
        window.api.plugin.list(),
        window.api.plugin.statuses()
      ])
      if (disposed) return
      setPlugins(list)
      setStatuses(stats)
    }

    load()

    // Poll status every 3s while panel is open
    const interval = setInterval(async () => {
      const stats = await window.api.plugin.statuses()
      if (!disposed) setStatuses(stats)
    }, 3000)

    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [visible])

  async function handleToggle(id: string): Promise<void> {
    const result = await window.api.plugin.toggle(id)
    if (result.ok) {
      setPlugins((prev) =>
        prev.map((p) => (p.id === id ? { ...p, enabled: result.enabled! } : p))
      )
      const stats = await window.api.plugin.statuses()
      setStatuses(stats)
    }
  }

  async function handleRestart(id: string): Promise<void> {
    await window.api.plugin.restart(id)
    const stats = await window.api.plugin.statuses()
    setStatuses(stats)
  }

  async function handleRemove(id: string): Promise<void> {
    const result = await window.api.plugin.remove(id)
    if (result.ok) {
      setPlugins((prev) => prev.filter((p) => p.id !== id))
    }
  }

  async function handleAdd(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const id = addId.trim()
    const command = addCommand.trim()
    if (!id || !command) return

    const entry: PluginEntry = {
      id,
      type: 'mcp',
      command,
      args: addArgs.trim() ? addArgs.trim().split(' ') : [],
      enabled: true
    }

    const result = await window.api.plugin.add(entry)
    if (!result.ok) {
      setAddError(result.error || 'Failed to add plugin')
    } else {
      setPlugins((prev) => [...prev, result.plugin!])
      setAdding(false)
      setAddId('')
      setAddCommand('')
      setAddArgs('')
      setAddError(null)
    }
  }

  function getStatus(id: string): PluginStatus | undefined {
    return statuses.find((s) => s.id === id)
  }

  function statusDot(status: string): string {
    if (status === 'running') return 'deck-dot--green'
    if (status === 'error') return 'deck-dot--red'
    return 'deck-dot--grey'
  }

  function statusLabel(status: string): string {
    if (status === 'running') return 'running'
    if (status === 'error') return 'error'
    return 'stopped'
  }

  if (!visible) return null

  return (
    <div className="deck-plugin-overlay" onClick={onClose}>
      <div className="deck-plugin-panel" onClick={(e) => e.stopPropagation()}>
        <div className="deck-plugin-header">
          <span className="deck-plugin-title">Plugins</span>
          <div className="deck-sidebar-header-actions">
            <button
              className="deck-sidebar-add-btn"
              onClick={() => setAdding(true)}
              title="Add plugin"
            >
              +
            </button>
            <button className="deck-sidebar-add-btn" onClick={onClose} title="Close">
              x
            </button>
          </div>
        </div>

        {adding && (
          <form className="deck-sidebar-form" onSubmit={handleAdd}>
            <input
              className="deck-sidebar-input"
              placeholder="plugin-id"
              value={addId}
              onChange={(e) => setAddId(e.target.value)}
              autoFocus
            />
            <input
              className="deck-sidebar-input"
              placeholder="command (e.g. npx)"
              value={addCommand}
              onChange={(e) => setAddCommand(e.target.value)}
            />
            <input
              className="deck-sidebar-input"
              placeholder="args (space-separated)"
              value={addArgs}
              onChange={(e) => setAddArgs(e.target.value)}
            />
            {addError && <div className="deck-sidebar-error">{addError}</div>}
            <div className="deck-sidebar-form-actions">
              <button type="submit" className="deck-sidebar-btn deck-sidebar-btn--ok">Add</button>
              <button
                type="button"
                className="deck-sidebar-btn"
                onClick={() => { setAdding(false); setAddError(null) }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {plugins.length === 0 && !adding && (
          <div className="deck-plugin-empty">No plugins. Click + to add one.</div>
        )}

        {plugins.map((plugin) => {
          const st = getStatus(plugin.id)
          const status = st ? st.status : 'stopped'
          return (
            <div key={plugin.id} className="deck-plugin-item">
              <span className={`deck-dot ${statusDot(status)}`} />
              <div className="deck-plugin-info">
                <span className="deck-plugin-name">{plugin.id}</span>
                <span className="deck-plugin-status">{statusLabel(status)}</span>
              </div>
              <div className="deck-plugin-actions">
                {status === 'error' && (
                  <button
                    className="deck-sidebar-btn"
                    onClick={() => handleRestart(plugin.id)}
                  >
                    Restart
                  </button>
                )}
                <button
                  className={`deck-plugin-toggle${plugin.enabled ? ' deck-plugin-toggle--on' : ''}`}
                  onClick={() => handleToggle(plugin.id)}
                  title={plugin.enabled ? 'Disable' : 'Enable'}
                >
                  {plugin.enabled ? 'ON' : 'OFF'}
                </button>
                <button
                  className="deck-sidebar-remove-btn deck-plugin-remove"
                  onClick={() => handleRemove(plugin.id)}
                  title="Remove"
                >
                  x
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default PluginPanel
