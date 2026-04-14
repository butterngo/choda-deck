import { useEffect, useState, useCallback } from 'react'
import FileTree from './FileTree'
import MarkdownViewer from './MarkdownViewer'
import SearchBar from './SearchBar'
import type { FileNode } from './FileTree'

interface FilesViewProps {
  visible: boolean
}

function FilesView({ visible }: FilesViewProps): React.JSX.Element {
  const [contentRoot, setContentRoot] = useState<string | null>(null)
  const [tree, setTree] = useState<FileNode[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load contentRoot on mount
  useEffect(() => {
    let disposed = false
    window.api.vault.contentRoot().then((root) => {
      if (disposed) return
      if (root) {
        setContentRoot(root)
      } else {
        setError('No contentRoot configured in projects.json')
      }
    })
    return () => { disposed = true }
  }, [])

  // Load tree when contentRoot is available
  useEffect(() => {
    if (!contentRoot) return
    let disposed = false
    setLoading(true)
    window.api.vault.tree(contentRoot).then((nodes) => {
      if (disposed) return
      setTree(nodes as FileNode[])
      setLoading(false)
    }).catch(() => {
      if (disposed) return
      setError('Failed to read vault directory')
      setLoading(false)
    })
    return () => { disposed = true }
  }, [contentRoot])

  // Load file content when selectedPath changes
  useEffect(() => {
    if (!selectedPath) {
      setFileContent(null)
      return
    }
    let disposed = false
    window.api.vault.read(selectedPath).then((stat) => {
      if (disposed) return
      setFileContent(stat.content)
    }).catch(() => {
      if (disposed) return
      setFileContent(null)
      setError('Failed to read file')
    })
    return () => { disposed = true }
  }, [selectedPath])

  const handleFileSelect = useCallback((path: string) => {
    if (selectedPath) {
      setHistory((prev) => [...prev, selectedPath])
    }
    setSelectedPath(path)
    setError(null)
  }, [selectedPath])

  const handleBack = useCallback(() => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    setSelectedPath(prev)
    setError(null)
  }, [history])

  const handleWikilinkClick = useCallback((wikilink: string) => {
    if (!contentRoot) return
    window.api.vault.resolve(wikilink, contentRoot).then((resolved) => {
      if (resolved) {
        handleFileSelect(resolved)
      } else {
        setError(`Could not resolve [[${wikilink}]]`)
      }
    })
  }, [contentRoot, handleFileSelect])

  const handleRefresh = useCallback(() => {
    if (!contentRoot) return
    setLoading(true)
    window.api.vault.tree(contentRoot).then((nodes) => {
      setTree(nodes as FileNode[])
      setLoading(false)
    }).catch(() => {
      setError('Failed to refresh')
      setLoading(false)
    })
  }, [contentRoot])

  if (!visible) return <div className="deck-terminal--hidden" />

  if (error && !contentRoot) {
    return (
      <div className="deck-files">
        <div className="deck-md-empty">{error}</div>
      </div>
    )
  }

  return (
    <div className="deck-files">
      <div className="deck-files-toolbar">
        <button
          className="deck-files-btn"
          disabled={history.length === 0}
          onClick={handleBack}
          title="Back"
        >
          &larr;
        </button>
        <button
          className="deck-files-btn"
          onClick={handleRefresh}
          title="Refresh tree"
        >
          &#8635;
        </button>
        {contentRoot && (
          <SearchBar contentRoot={contentRoot} onSelect={handleFileSelect} />
        )}
        {error && <span className="deck-files-error">{error}</span>}
      </div>
      <div className="deck-files-split">
        <div className="deck-files-tree">
          {loading
            ? <div className="deck-ftree-empty">Loading...</div>
            : <FileTree nodes={tree} selectedPath={selectedPath} onSelect={handleFileSelect} />
          }
        </div>
        <div className="deck-files-content">
          {selectedPath && fileContent !== null ? (
            <MarkdownViewer
              content={fileContent}
              filePath={selectedPath}
              onWikilinkClick={handleWikilinkClick}
            />
          ) : (
            <div className="deck-md-empty">Select a file to view</div>
          )}
        </div>
      </div>
    </div>
  )
}

export default FilesView
