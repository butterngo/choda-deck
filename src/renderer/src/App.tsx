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
import PipelineView from './PipelineView'
import type { ProjectConfig, WorkspaceConfig } from '../../preload/index'
import type { ViewType } from './ViewRouter'
import type { Session } from '../../tasks/task-types'
import type {
  PipelineStageStatus,
  PipelineState
} from '../../core/harness/pipeline-state'

// Active selection: which workspace is selected + its parent project
interface ActiveSelection {
  projectId: string
  workspaceId: string
}

// Sidebar badge signals — subset of PipelineStageStatus we surface.
export type PipelineSignal = 'ready' | 'running' | 'rejected'

// Sessions with these stageStatuses represent "work in flight" from the user's
// perspective. 'approved' is transient between stages; 'running' of the next
// stage will replace it almost immediately.
const ACTIVE_STAGE_STATUSES: PipelineStageStatus[] = ['ready', 'running', 'rejected']

function isActivePipelineSession(s: Session): boolean {
  if (s.pipelineStage === null || s.pipelineStageStatus === null) return false
  return ACTIVE_STAGE_STATUSES.includes(s.pipelineStageStatus)
}

// Ready > running > rejected; tie-break by most recently started.
function pickBestPipelineSession(sessions: Session[]): Session | null {
  const active = sessions.filter(isActivePipelineSession)
  if (active.length === 0) return null
  const rank: Record<PipelineStageStatus, number> = {
    ready: 0,
    running: 1,
    rejected: 2,
    approved: 3
  }
  return active.sort((a, b) => {
    const ra = rank[a.pipelineStageStatus!] ?? 99
    const rb = rank[b.pipelineStageStatus!] ?? 99
    if (ra !== rb) return ra - rb
    return b.startedAt.localeCompare(a.startedAt)
  })[0]
}

function App(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectConfig[]>([])
  const [active, setActive] = useState<ActiveSelection | null>(null)
  const [vaultRoot, setVaultRoot] = useState<string>('')
  const [pipelineSessions, setPipelineSessions] = useState<Record<string, Session>>({})

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

  // Refresh the active-pipeline-session map for a single project. We refetch
  // per-project (instead of a global refetch) to keep this cheap on broadcast.
  async function refreshProjectPipeline(projectId: string): Promise<void> {
    const sessions = (await window.api.session.list(projectId)) as Session[]
    const best = pickBestPipelineSession(sessions)
    setPipelineSessions((prev) => {
      const next = { ...prev }
      if (best) next[projectId] = best
      else delete next[projectId]
      return next
    })
  }

  // Initial fetch + subscribe to any pipeline stage change (from any session).
  useEffect(() => {
    if (projects.length === 0) return
    let disposed = false
    for (const p of projects) {
      if (disposed) break
      refreshProjectPipeline(p.id)
    }
    const unsubscribe = window.api.pipeline.onAnyStageChange((state: PipelineState) => {
      if (!disposed) refreshProjectPipeline(state.projectId)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [projects])

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
      },
      {
        id: 'pipeline',
        label: 'Pipeline',
        render: (project, _workspace, visible) => (
          <PipelineView visible={visible} sessionId={pipelineSessions[project.id]?.id ?? null} />
        )
      }
    ],
    [vaultRoot, pipelineSessions]
  )

  const pipelineSignals = useMemo<Record<string, PipelineSignal>>(() => {
    const out: Record<string, PipelineSignal> = {}
    for (const [projectId, session] of Object.entries(pipelineSessions)) {
      const status = session.pipelineStageStatus
      if (status === 'ready' || status === 'running' || status === 'rejected') {
        out[projectId] = status
      }
    }
    return out
  }, [pipelineSessions])

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
          pipelineSignals={pipelineSignals}
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
          {allWorkspaces.map(({ project, workspace }) => {
            const projectViewTypes = pipelineSessions[project.id]
              ? viewTypes
              : viewTypes.filter((vt) => vt.id !== 'pipeline')
            return (
              <ViewRouter
                key={workspace.id}
                project={project}
                workspace={workspace}
                visible={workspace.id === active?.workspaceId}
                viewTypes={projectViewTypes}
              />
            )
          })}
        </main>
      </div>
    </div>
  )
}

export default App
