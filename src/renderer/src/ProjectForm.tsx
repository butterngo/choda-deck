import { useState } from 'react'

interface ProjectFormProps {
  mode: 'project' | 'workspace'
  projectId?: string
  onSubmit: (data: {
    projectId: string
    name: string
    workspaceId: string
    workspaceLabel: string
    cwd: string
  }) => void
  onCancel: () => void
}

function ProjectForm({ mode, projectId, onSubmit, onCancel }: ProjectFormProps): React.JSX.Element {
  const [id, setId] = useState(projectId ?? '')
  const [name, setName] = useState('')
  const [wsId, setWsId] = useState('')
  const [wsLabel, setWsLabel] = useState('')
  const [cwd, setCwd] = useState('')

  const isProject = mode === 'project'
  const title = isProject ? 'Add Project' : 'Add Workspace'

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    onSubmit({
      projectId: id,
      name: name || id,
      workspaceId: wsId || id,
      workspaceLabel: wsLabel || 'Main',
      cwd
    })
  }

  return (
    <div className="deck-form-overlay" onClick={onCancel}>
      <form
        className="deck-form-panel"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="deck-form-title">{title}</div>

        {isProject && (
          <>
            <label className="deck-form-label">
              Project ID
              <input
                className="deck-form-input"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="automation-rule"
                required
                autoFocus
              />
            </label>
            <label className="deck-form-label">
              Project Name
              <input
                className="deck-form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Automation Rule"
              />
            </label>
          </>
        )}

        <label className="deck-form-label">
          Workspace ID
          <input
            className="deck-form-input"
            value={wsId}
            onChange={(e) => setWsId(e.target.value)}
            placeholder="workflow-engine"
            required={!isProject}
            autoFocus={!isProject}
          />
        </label>
        <label className="deck-form-label">
          Label
          <input
            className="deck-form-input"
            value={wsLabel}
            onChange={(e) => setWsLabel(e.target.value)}
            placeholder="BE"
          />
        </label>
        <label className="deck-form-label">
          Working Directory
          <input
            className="deck-form-input"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="C:\dev\project"
            required
          />
        </label>

        <div className="deck-form-actions">
          <button type="button" className="deck-sidebar-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="deck-sidebar-btn deck-btn-primary">
            Add
          </button>
        </div>
      </form>
    </div>
  )
}

export default ProjectForm
