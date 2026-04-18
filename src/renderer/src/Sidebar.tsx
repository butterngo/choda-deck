import { useState } from 'react'
import type { ProjectConfig } from '../../preload/index'
import ProjectForm from './ProjectForm'
import SettingsModal from './SettingsModal'

const HELP_TEXT = `Keyboard Shortcuts
─────────────────
Ctrl+1..9      Switch to workspace by number
Ctrl+Tab       Next workspace
Ctrl+Shift+Tab Previous workspace

Sidebar
─────────────────
?  button      Help
+  button      Add project / workspace

Views (per workspace)
─────────────────
Terminal       Live claude session
Tasks          Kanban board (read-only)
Focus          Today's tasks`

type FormState =
  | { open: false }
  | { open: true; mode: 'project' }
  | { open: true; mode: 'workspace'; projectId: string }

interface SidebarProps {
  projects: ProjectConfig[]
  activeWorkspaceId: string
  onSelect: (projectId: string, workspaceId: string) => void
  onProjectsChanged: () => void
}

function Sidebar({
  projects,
  activeWorkspaceId,
  onSelect,
  onProjectsChanged
}: SidebarProps): React.JSX.Element {
  const [showHelp, setShowHelp] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [form, setForm] = useState<FormState>({ open: false })
  const [collapsed, setCollapsed] = useState(false)

  function activeProjectId(): string | null {
    for (const p of projects) {
      if (p.workspaces.some((ws) => ws.id === activeWorkspaceId)) return p.id
    }
    return null
  }

  async function handleFormSubmit(data: {
    projectId: string
    name: string
    workspaceId: string
    workspaceLabel: string
    cwd: string
  }): Promise<void> {
    const result = await window.api.project.add(
      data.projectId,
      data.name,
      data.workspaceId,
      data.workspaceLabel,
      data.cwd
    )
    if (result.ok) {
      setForm({ open: false })
      onProjectsChanged()
    }
  }

  if (collapsed) {
    return (
      <aside className="deck-sidebar deck-sidebar--collapsed">
        <button
          className="deck-sidebar-hamburger"
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
        >
          &#9776;
        </button>
      </aside>
    )
  }

  return (
    <aside className="deck-sidebar">
      <div className="deck-sidebar-header">
        <button
          className="deck-sidebar-hamburger"
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
        >
          &#9776;
        </button>
        <span className="deck-sidebar-title">Projects</span>
        <div className="deck-sidebar-header-actions">
          <button
            className="deck-sidebar-add-btn"
            onClick={() => setForm({ open: true, mode: 'project' })}
            title="Add project"
          >
            +
          </button>
          <button
            className="deck-sidebar-add-btn"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            ⚙
          </button>
          <button className="deck-sidebar-add-btn" onClick={() => setShowHelp(true)} title="Help">
            ?
          </button>
        </div>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {showHelp && (
        <div className="deck-help-overlay" onClick={() => setShowHelp(false)}>
          <div className="deck-help-panel" onClick={(e) => e.stopPropagation()}>
            <pre className="deck-help-text">{HELP_TEXT}</pre>
            <button className="deck-sidebar-btn" onClick={() => setShowHelp(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      {form.open && (
        <ProjectForm
          mode={form.mode}
          projectId={form.mode === 'workspace' ? form.projectId : undefined}
          onSubmit={handleFormSubmit}
          onCancel={() => setForm({ open: false })}
        />
      )}

      {projects.map((project) => {
        const isActive = project.id === activeProjectId()
        const firstWs = project.workspaces[0]
        return (
          <div key={project.id} className="deck-sidebar-project">
            <button
              className={`deck-sidebar-project-name-btn${isActive ? ' deck-sidebar-item--active' : ''}`}
              onClick={() => firstWs && onSelect(project.id, firstWs.id)}
            >
              {project.name}
            </button>
          </div>
        )
      })}
    </aside>
  )
}

export default Sidebar
