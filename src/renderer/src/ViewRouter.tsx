import { useState, useEffect } from 'react'
import type { ProjectConfig, WorkspaceConfig } from '../../preload/index'
import TerminalView from './TerminalView'

export interface ViewType {
  id: string
  label: string
  render: (
    project: ProjectConfig,
    workspace: WorkspaceConfig,
    visible: boolean
  ) => React.JSX.Element
}

interface ViewRouterProps {
  project: ProjectConfig
  workspace: WorkspaceConfig
  visible: boolean
  viewTypes: ViewType[]
}

function ViewRouter({
  project,
  workspace,
  visible,
  viewTypes
}: ViewRouterProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState(viewTypes[0]?.id || 'terminal')

  useEffect(() => {
    function handleSwitch(e: Event): void {
      const detail = (e as CustomEvent).detail
      if (detail?.tab) setActiveTab(detail.tab)
    }
    window.addEventListener('deck:switch-tab', handleSwitch)
    return () => window.removeEventListener('deck:switch-tab', handleSwitch)
  }, [])

  return (
    <div className={`deck-view-router${visible ? '' : ' deck-terminal--hidden'}`}>
      <div className="deck-tab-bar">
        {viewTypes.map((vt) => (
          <button
            key={vt.id}
            className={`deck-tab${activeTab === vt.id ? ' deck-tab--active' : ''}`}
            onClick={() => setActiveTab(vt.id)}
          >
            {vt.label}
          </button>
        ))}
      </div>
      <div className="deck-view-container">
        {viewTypes.map((vt) => (
          <div
            key={vt.id}
            className={`deck-view${activeTab === vt.id ? '' : ' deck-terminal--hidden'}`}
          >
            {vt.render(project, workspace, visible && activeTab === vt.id)}
          </div>
        ))}
      </div>
    </div>
  )
}

export const terminalViewType: ViewType = {
  id: 'terminal',
  label: 'Terminal',
  render: (_project, workspace, visible) => (
    <TerminalView workspaceId={workspace.id} cwd={workspace.cwd} visible={visible} />
  )
}

export default ViewRouter
