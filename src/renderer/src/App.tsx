import { useEffect, useMemo, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import './assets/deck.css'
import Sidebar from './Sidebar'
import ViewRouter from './ViewRouter'
import TerminalView from './TerminalView'
import KanbanBoard from './KanbanBoard'
import FilesView from './FilesView'
import ActivityView from './ActivityView'
import InboxView from './InboxView'
import type { ProjectConfig, WorkspaceConfig } from '../../preload/index'
import type { ViewType } from './ViewRouter'

// Active selection: which workspace is selected + its parent project
interface ActiveSelection {
  projectId: string
  workspaceId: string
}

function App(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectConfig[]>([])
  const [active, setActive] = useState<ActiveSelection | null>(null)
  const [vaultRoot, setVaultRoot] = useState<string>('')

  // Load projects + vault contentRoot on mount
  useEffect(() => {
    let disposed = false
    window.api.project.list().then((list) => {
      if (disposed) return
      setProjects(list)
      if (list.length > 0 && list[0].workspaces.length > 0) {
        setActive({ projectId: list[0].id, workspaceId: list[0].workspaces[0].id })
      }
    })
    window.api.vault.contentRoot().then((root) => {
      if (!disposed) setVaultRoot(root)
    })
    return () => {
      disposed = true
    }
  }, [])

  const viewTypes: ViewType[] = useMemo(
    () => [
      {
        id: 'terminal',
        label: 'Terminal',
        render: (_project, workspace, visible) => (
          <TerminalView
            workspaceId={`${workspace.id}-vault`}
            cwd={vaultRoot || workspace.cwd}
            visible={visible}
          />
        )
      },
      {
        id: 'inbox',
        label: 'Inbox',
        render: (project, _workspace, visible) => (
          <InboxView projectId={project.id} visible={visible} />
        )
      },
      {
        id: 'tasks',
        label: 'Board',
        render: (project, _workspace, visible) => (
          <KanbanBoard projectId={project.id} visible={visible} />
        )
      },
      {
        id: 'activity',
        label: 'Activity',
        render: (project, _workspace, visible) => (
          <ActivityView projectId={project.id} visible={visible} />
        )
      },
      {
        id: 'files',
        label: 'Wiki',
        render: (_project, _workspace, visible) => <FilesView visible={visible} />
      }
    ],
    [vaultRoot]
  )

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
          const idx = allWorkspaces.findIndex((w) => w.workspace.id === curr.workspaceId)
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

  const activeProject = active ? projects.find((p) => p.id === active.projectId) : null
  const activeWorkspace = activeProject?.workspaces.find((w) => w.id === active?.workspaceId)

  return (
    <div className="deck-root">
      <div className="deck-layout">
        <Sidebar
          projects={projects}
          activeWorkspaceId={active?.workspaceId || ''}
          onSelect={handleSelect}
          onProjectsChanged={() => {
            window.api.project.list().then(setProjects)
          }}
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
              viewTypes={viewTypes}
            />
          ))}
        </main>
      </div>
    </div>
  )
}

export default App
