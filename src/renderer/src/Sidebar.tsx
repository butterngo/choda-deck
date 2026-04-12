import { useState } from 'react'
import type { SpikeProject } from '../../preload/index'

interface SidebarProps {
  projects: SpikeProject[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: (id: string, cwd: string) => Promise<string | null>
  onRemove: (id: string) => Promise<void>
}

function Sidebar({ projects, activeId, onSelect, onAdd, onRemove }: SidebarProps): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [addId, setAddId] = useState('')
  const [addCwd, setAddCwd] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const id = addId.trim()
    const cwd = addCwd.trim()
    if (!id || !cwd) return

    const error = await onAdd(id, cwd)
    if (error) {
      setAddError(error)
    } else {
      setAdding(false)
      setAddId('')
      setAddCwd('')
      setAddError(null)
    }
  }

  function handleCancel(): void {
    setAdding(false)
    setAddId('')
    setAddCwd('')
    setAddError(null)
  }

  return (
    <aside className="deck-sidebar">
      <div className="deck-sidebar-header">
        <span className="deck-sidebar-title">Projects</span>
        <button
          className="deck-sidebar-add-btn"
          onClick={() => setAdding(true)}
          title="Add project"
        >
          +
        </button>
      </div>

      {adding && (
        <form className="deck-sidebar-form" onSubmit={handleSubmit}>
          <input
            className="deck-sidebar-input"
            placeholder="project-id"
            value={addId}
            onChange={(e) => setAddId(e.target.value)}
            autoFocus
          />
          <input
            className="deck-sidebar-input"
            placeholder="C:\path\to\project"
            value={addCwd}
            onChange={(e) => setAddCwd(e.target.value)}
          />
          {addError && <div className="deck-sidebar-error">{addError}</div>}
          <div className="deck-sidebar-form-actions">
            <button type="submit" className="deck-sidebar-btn deck-sidebar-btn--ok">Add</button>
            <button type="button" className="deck-sidebar-btn" onClick={handleCancel}>Cancel</button>
          </div>
        </form>
      )}

      {projects.map((project, index) => (
        <div
          key={project.id}
          className={`deck-sidebar-item${project.id === activeId ? ' deck-sidebar-item--active' : ''}`}
        >
          <button
            className="deck-sidebar-item-btn"
            onClick={() => onSelect(project.id)}
          >
            {index < 9 && <span className="deck-sidebar-key">{index + 1}</span>}
            <span className="deck-sidebar-label">{project.id}</span>
          </button>
          <button
            className="deck-sidebar-remove-btn"
            onClick={() => onRemove(project.id)}
            title="Remove project"
          >
            x
          </button>
        </div>
      ))}
    </aside>
  )
}

export default Sidebar
