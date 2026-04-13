import { useEffect, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import './assets/deck.css'
import Sidebar from './Sidebar'
import ViewRouter, { terminalViewType } from './ViewRouter'
import PluginPanel from './PluginPanel'
import KanbanBoard from './KanbanBoard'
import RoadmapView from './RoadmapView'
import type { SpikeProject } from '../../preload/index'
import type { ViewType } from './ViewRouter'

// Register all view types here — future views (notes, graph) added to this array
const VIEW_TYPES: ViewType[] = [
  terminalViewType,
  {
    id: 'tasks',
    label: 'Tasks',
    render: (project, visible) => <KanbanBoard project={project} visible={visible} />
  },
  {
    id: 'roadmap',
    label: 'Roadmap',
    render: (project, visible) => <RoadmapView project={project} visible={visible} />
  }
]

function App(): React.JSX.Element {
  const [projects, setProjects] = useState<SpikeProject[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [showPlugins, setShowPlugins] = useState(false)

  // Load projects on mount
  useEffect(() => {
    let disposed = false
    window.api.project.list().then((list) => {
      if (disposed) return
      setProjects(list)
      if (list.length > 0) setActiveId(list[0].id)
    })
    return () => { disposed = true }
  }, [])

  // Keyboard shortcuts — single top-level listener
  useEffect(() => {
    if (projects.length === 0) return

    function handleKeyDown(e: KeyboardEvent): void {
      // Ctrl+1..9 → jump to project by index
      if (e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1
        if (idx < projects.length) {
          e.preventDefault()
          setActiveId(projects[idx].id)
        }
        return
      }

      // Ctrl+Tab → next, Ctrl+Shift+Tab → prev
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        setActiveId((currentId) => {
          const curr = projects.findIndex((p) => p.id === currentId)
          const next = e.shiftKey
            ? (curr - 1 + projects.length) % projects.length
            : (curr + 1) % projects.length
          return projects[next].id
        })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [projects])

  async function handleAddProject(id: string, cwd: string): Promise<string | null> {
    const result = await window.api.project.add(id, cwd)
    if (!result.ok) return result.error || 'Failed to add project'
    if (result.project) {
      setProjects((prev) => [...prev, result.project!])
      setActiveId(id)
    }
    return null
  }

  async function handleRemoveProject(id: string): Promise<void> {
    const result = await window.api.project.remove(id)
    if (!result.ok) return
    setProjects((prev) => {
      const next = prev.filter((p) => p.id !== id)
      if (activeId === id && next.length > 0) setActiveId(next[0].id)
      return next
    })
  }

  const activeProject = projects.find((p) => p.id === activeId)

  return (
    <div className="deck-root">
      <div className="deck-layout">
        <Sidebar
          projects={projects}
          activeId={activeId}
          onSelect={setActiveId}
          onAdd={handleAddProject}
          onRemove={handleRemoveProject}
        />
        <main className="deck-main">
          <header className="deck-header">
            <div className="deck-title">Choda Deck</div>
            <div className="deck-project">
              {activeProject ? `${activeProject.id} — ${activeProject.cwd}` : ''}
            </div>
            <button
              className="deck-header-btn"
              onClick={() => setShowPlugins(true)}
              title="Plugins"
            >
              &#9881;
            </button>
          </header>
          <PluginPanel visible={showPlugins} onClose={() => setShowPlugins(false)} />
          {projects.map((p) => (
            <ViewRouter
              key={p.id}
              project={p}
              visible={p.id === activeId}
              viewTypes={VIEW_TYPES}
            />
          ))}
        </main>
      </div>
    </div>
  )
}

export default App
