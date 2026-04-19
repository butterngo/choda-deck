import BackupsPanel from './BackupsPanel'
import McpPanel from './McpPanel'

interface SettingsModalProps {
  onClose: () => void
}

function SettingsModal({ onClose }: SettingsModalProps): React.JSX.Element {
  return (
    <div className="deck-help-overlay" onClick={onClose}>
      <div className="deck-help-panel deck-settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="deck-settings-header">
          <span className="deck-settings-title">Settings</span>
          <button className="deck-sidebar-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="deck-settings-body">
          <BackupsPanel />
          <McpPanel />
        </div>
      </div>
    </div>
  )
}

export default SettingsModal
