import { useState } from 'react'
import type { ProjectConfig } from '../../preload/index'
import ProjectForm from './ProjectForm'
import SettingsModal from './SettingsModal'

// Kept in sync with App.tsx PipelineSignal — inlined to avoid a type-only
// circular import between App and Sidebar.
type PipelineSignal = 'ready' | 'running' | 'rejected'

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
  pipelineSignals: Record<string, PipelineSignal>
}

function PipelineBadge({ signal }: { signal: PipelineSignal }): React.JSX.Element {
  const label =
    signal === 'ready'
      ? 'Plan ready for review'
      : signal === 'running'
        ? 'Pipeline running'
        : 'Plan rejected — awaiting re-run'
  return (
    <span
      className={`deck-sidebar-pipeline-badge deck-sidebar-pipeline-badge--${signal}`}
      title={label}
      aria-label={label}
    />
  )
}

function Sidebar({
  projects,
  activeWorkspaceId,
  onSelect,
  onProjectsChanged,
  pipelineSignals
}: SidebarProps): React.JSX.Element {
  const [showHelp, setShowHelp] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [form, setForm] = useState<FormState>({ open: false })
  const [collapsed, setCollapsed] = useState(false)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())

  function toggleProject(projectId: string): void {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

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

      {(() => {
        let wsIndex = 0
        return projects.map((project) => {
          const isProjectActive = project.id === activeProjectId()
          const isCollapsed = !expandedProjects.has(project.id)
          if (isCollapsed) wsIndex += project.workspaces.length
          return (
            <div key={project.id} className="deck-sidebar-project">
              <button
                className={`deck-sidebar-project-header${isProjectActive ? ' deck-sidebar-project-header--active' : ''}`}
                onClick={() => toggleProject(project.id)}
                title={isCollapsed ? 'Expand' : 'Collapse'}
              >
                <span className="deck-sidebar-chevron">{isCollapsed ? '▶' : '▼'}</span>
                <span className="deck-sidebar-project-name">{project.name}</span>
                {pipelineSignals[project.id] && (
                  <PipelineBadge signal={pipelineSignals[project.id]} />
                )}
              </button>
              {!isCollapsed &&
                project.workspaces.map((ws) => {
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
          )
        })
      })()}
    </aside>
  )
}

export default Sidebar
