import { useCallback, useEffect, useState } from 'react'

interface BackupInfo {
  filename: string
  date: string
  size: number
  mtimeMs: number
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function BackupsPanel(): React.JSX.Element {
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const load = useCallback(async () => {
    const list = (await window.api.backup.list()) as BackupInfo[]
    setBackups(list)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleCreateNow(): Promise<void> {
    if (busy) return
    setBusy(true)
    setStatus(null)
    const res = await window.api.backup.createNow()
    setBusy(false)
    if (res.ok && res.backup) {
      setStatus(`Created ${res.backup.filename}`)
      load()
    } else {
      setStatus(`Failed: ${res.error}`)
    }
  }

  async function handleRestore(filename: string): Promise<void> {
    if (busy) return
    const ok = confirm(`Replace current data with ${filename}? The app will restart.`)
    if (!ok) return
    setBusy(true)
    const res = await window.api.backup.restore(filename)
    if (!res.ok) {
      setBusy(false)
      setStatus(`Restore failed: ${res.error}`)
    }
    // On success, app relaunches — no further UI updates.
  }

  return (
    <div className="deck-backups">
      <div className="deck-backups-header">
        <span className="deck-backups-title">Backups</span>
        <button
          className="deck-sidebar-btn"
          onClick={handleCreateNow}
          disabled={busy}
          title="Create a snapshot now"
        >
          Backup now
        </button>
        <button className="deck-sidebar-btn" onClick={load} disabled={busy} title="Refresh">
          ↻
        </button>
      </div>

      {status && <div className="deck-backups-status">{status}</div>}

      {backups.length === 0 ? (
        <div className="deck-backups-empty">
          No backups yet. One will be created automatically on the next startup, or click
          &quot;Backup now&quot;.
        </div>
      ) : (
        <ul className="deck-backups-list">
          {backups.map((b) => (
            <li key={b.filename} className="deck-backups-row">
              <div className="deck-backups-row-main">
                <span className="deck-backups-row-filename">{b.filename}</span>
                <span className="deck-backups-row-meta">
                  {b.date} · {formatSize(b.size)}
                </span>
              </div>
              <button
                className="deck-sidebar-btn"
                onClick={() => handleRestore(b.filename)}
                disabled={busy}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default BackupsPanel
