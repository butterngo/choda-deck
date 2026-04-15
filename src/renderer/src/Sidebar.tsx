import { useState } from 'react'
import type { ProjectConfig } from '../../preload/index'

const HELP_TEXT = `Keyboard Shortcuts
─────────────────
Ctrl+1..9      Switch to workspace by number
Ctrl+Tab       Next workspace
Ctrl+Shift+Tab Previous workspace

Sidebar
─────────────────
?  button      Help
+  button      Add project (coming soon)

Views (per workspace)
─────────────────
Terminal       Live claude session
Tasks          Kanban board (read-only)
Roadmap        Phase/Feature progress overview
Focus          Today's tasks`

interface SidebarProps {
  projects: ProjectConfig[]
  activeWorkspaceId: string
  onSelect: (projectId: string, workspaceId: string) => void
}

function Sidebar({ projects, activeWorkspaceId, onSelect }: SidebarProps): React.JSX.Element {
  const [showHelp, setShowHelp] = useState(false)

  let wsIndex = 0

  return (
    <aside className="deck-sidebar">
      <div className="deck-sidebar-header">
        <span className="deck-sidebar-title">Projects</span>
        <div className="deck-sidebar-header-actions">
          <button
            className="deck-sidebar-add-btn"
            onClick={() => setShowHelp(true)}
            title="Help"
          >
            ?
          </button>
        </div>
      </div>

      {showHelp && (
        <div className="deck-help-overlay" onClick={() => setShowHelp(false)}>
          <div className="deck-help-panel" onClick={(e) => e.stopPropagation()}>
            <pre className="deck-help-text">{HELP_TEXT}</pre>
            <button className="deck-sidebar-btn" onClick={() => setShowHelp(false)}>Close</button>
          </div>
        </div>
      )}

      {projects.map((project) => (
        <div key={project.id} className="deck-sidebar-project">
          <div className="deck-sidebar-project-header">
            {project.name}
          </div>
          {project.workspaces.map((ws) => {
            const idx = wsIndex++
            const isActive = ws.id === activeWorkspaceId
            return (
              <button
                key={ws.id}
                className={`deck-sidebar-item-btn${isActive ? ' deck-sidebar-item--active' : ''}`}
                onClick={() => onSelect(project.id, ws.id)}
              >
                {idx < 9 && <span className="deck-sidebar-key">{idx + 1}</span>}
                <span className="deck-sidebar-label">{ws.label}</span>
              </button>
            )
          })}
        </div>
      ))}
    </aside>
  )
}

export default Sidebar
