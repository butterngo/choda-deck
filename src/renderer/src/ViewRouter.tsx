import { useState } from 'react'
import type { SpikeProject } from '../../preload/index'
import TerminalView from './TerminalView'

export interface ViewType {
  id: string
  label: string
  render: (project: SpikeProject, visible: boolean) => React.JSX.Element
}

interface ViewRouterProps {
  project: SpikeProject
  visible: boolean
  viewTypes: ViewType[]
}

function ViewRouter({ project, visible, viewTypes }: ViewRouterProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState(viewTypes[0]?.id || 'terminal')

  // All views mounted once, shown/hidden by CSS
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
            {vt.render(project, visible && activeTab === vt.id)}
          </div>
        ))}
      </div>
    </div>
  )
}

// Default terminal view type
export const terminalViewType: ViewType = {
  id: 'terminal',
  label: 'Terminal',
  render: (project, visible) => <TerminalView project={project} visible={visible} />
}

export default ViewRouter
