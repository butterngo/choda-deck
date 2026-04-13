import { useEffect, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import './assets/deck.css'
import Sidebar from './Sidebar'
import ViewRouter, { terminalViewType } from './ViewRouter'
import KanbanBoard from './KanbanBoard'
import RoadmapView from './RoadmapView'
import DailyFocusView from './DailyFocusView'
import type { ProjectConfig, WorkspaceConfig } from '../../preload/index'
import type { ViewType } from './ViewRouter'

// Active selection: which workspace is selected + its parent project
interface ActiveSelection {
  projectId: string
  workspaceId: string
}

// Register all view types — future views (notes, graph) added here
const VIEW_TYPES: ViewType[] = [
  terminalViewType,
  {
    id: 'tasks',
    label: 'Tasks',
    render: (project, _workspace, visible) => (
      <KanbanBoard projectId={project.id} visible={visible} />
    )
  },
  {
    id: 'roadmap',
    label: 'Roadmap',
    render: (project, _workspace, visible) => (
      <RoadmapView projectId={project.id} visible={visible} />
    )
  },
  {
    id: 'focus',
    label: 'Focus',
    render: (_project, _workspace, visible) => (
      <DailyFocusView visible={visible} />
    )
  }
]

function App(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectConfig[]>([])
  const [active, setActive] = useState<ActiveSelection | null>(null)
  // Load projects on mount
  useEffect(() => {
    let disposed = false
    window.api.project.list().then((list) => {
      if (disposed) return
      setProjects(list)
      if (list.length > 0 && list[0].workspaces.length > 0) {
        setActive({ projectId: list[0].id, workspaceId: list[0].workspaces[0].id })
      }
    })
    return () => { disposed = true }
  }, [])

  // Flatten workspaces for keyboard shortcuts
  const allWorkspaces: Array<{ project: ProjectConfig; workspace: WorkspaceConfig }> = []
  for (const p of projects) {
    for (const ws of p.workspaces) {
      allWorkspaces.push({ project: p, workspace: ws })
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    if (allWorkspaces.length === 0) return

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1
        if (idx < allWorkspaces.length) {
          e.preventDefault()
          const { project, workspace } = allWorkspaces[idx]
          setActive({ projectId: project.id, workspaceId: workspace.id })
        }
        return
      }

      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        setActive((curr) => {
          if (!curr) return curr
          const idx = allWorkspaces.findIndex(w => w.workspace.id === curr.workspaceId)
          const next = e.shiftKey
            ? (idx - 1 + allWorkspaces.length) % allWorkspaces.length
            : (idx + 1) % allWorkspaces.length
          return {
            projectId: allWorkspaces[next].project.id,
            workspaceId: allWorkspaces[next].workspace.id
          }
        })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [allWorkspaces.length])

  function handleSelect(projectId: string, workspaceId: string): void {
    setActive({ projectId, workspaceId })
  }

  const activeProject = active ? projects.find(p => p.id === active.projectId) : null
  const activeWorkspace = activeProject?.workspaces.find(w => w.id === active?.workspaceId)

  return (
    <div className="deck-root">
      <div className="deck-layout">
        <Sidebar
          projects={projects}
          activeWorkspaceId={active?.workspaceId || ''}
          onSelect={handleSelect}
        />
        <main className="deck-main">
          <header className="deck-header">
            <div className="deck-title">Choda Deck</div>
            <div className="deck-project">
              {activeProject && activeWorkspace
                ? `${activeProject.name} / ${activeWorkspace.label} — ${activeWorkspace.cwd}`
                : ''}
            </div>
          </header>
          {allWorkspaces.map(({ project, workspace }) => (
            <ViewRouter
              key={workspace.id}
              project={project}
              workspace={workspace}
              visible={workspace.id === active?.workspaceId}
              viewTypes={VIEW_TYPES}
            />
          ))}
        </main>
      </div>
    </div>
  )
}

export default App
