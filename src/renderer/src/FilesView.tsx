import { useEffect, useState, useCallback, useRef } from 'react'
import FileTree from './FileTree'
import MarkdownViewer from './MarkdownViewer'
import SearchBar from './SearchBar'
import type { FileNode } from './FileTree'

type ViewMode = 'preview' | 'split' | 'edit'

interface FilesViewProps {
  visible: boolean
}

function FilesView({ visible }: FilesViewProps): React.JSX.Element {
  const [contentRoot, setContentRoot] = useState<string | null>(null)
  const [tree, setTree] = useState<FileNode[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [editContent, setEditContent] = useState<string>('')
  const [viewMode, setViewMode] = useState<ViewMode>('preview')
  const [isDirty, setIsDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [history, setHistory] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isMd = selectedPath?.toLowerCase().endsWith('.md') ?? false

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
    return () => {
      disposed = true
    }
  }, [])

  // Load tree when contentRoot is available
  useEffect(() => {
    if (!contentRoot) return
    let disposed = false
    setLoading(true)
    window.api.vault
      .tree(contentRoot)
      .then((nodes) => {
        if (disposed) return
        setTree(nodes as FileNode[])
        setLoading(false)
      })
      .catch(() => {
        if (disposed) return
        setError('Failed to read vault directory')
        setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [contentRoot])

  // Load file content when selectedPath changes
  useEffect(() => {
    if (!selectedPath) {
      setFileContent(null)
      setEditContent('')
      setIsDirty(false)
      return
    }
    let disposed = false
    window.api.vault
      .read(selectedPath)
      .then((stat) => {
        if (disposed) return
        setFileContent(stat.content)
        setEditContent(stat.content)
        setIsDirty(false)
        setSaveStatus('idle')
      })
      .catch(() => {
        if (disposed) return
        setFileContent(null)
        setError('Failed to read file')
      })
    return () => {
      disposed = true
    }
  }, [selectedPath])

  // Cleanup save timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  const handleSave = useCallback(() => {
    if (!selectedPath || !isMd) return
    window.api.vault
      .write(selectedPath, editContent)
      .then(() => {
        setFileContent(editContent)
        setIsDirty(false)
        setSaveStatus('saved')
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000)
      })
      .catch(() => {
        setSaveStatus('error')
      })
  }, [selectedPath, editContent, isMd])

  const handleEditChange = useCallback((value: string) => {
    setEditContent(value)
    setIsDirty(true)
    setSaveStatus('idle')
  }, [])

  const handleToggle = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleFileSelect = useCallback(
    (path: string) => {
      if (selectedPath) {
        setHistory((prev) => [...prev, selectedPath])
      }
      setSelectedPath(path)
      setError(null)
    },
    [selectedPath]
  )

  const handleBack = useCallback(() => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    setSelectedPath(prev)
    setError(null)
  }, [history])

  const handleWikilinkClick = useCallback(
    (wikilink: string) => {
      if (!contentRoot) return
      window.api.vault.resolve(wikilink, contentRoot).then((resolved) => {
        if (resolved) {
          handleFileSelect(resolved)
        } else {
          setError(`Could not resolve [[${wikilink}]]`)
        }
      })
    },
    [contentRoot, handleFileSelect]
  )

  const handleRefresh = useCallback(() => {
    if (!contentRoot) return
    setLoading(true)
    window.api.vault
      .tree(contentRoot)
      .then((nodes) => {
        setTree(nodes as FileNode[])
        setLoading(false)
      })
      .catch(() => {
        setError('Failed to refresh')
        setLoading(false)
      })
  }, [contentRoot])

  const handleDelete = useCallback(() => {
    if (!selectedPath) return
    const name = selectedPath.split(/[/\\]/).pop() ?? selectedPath
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return
    window.api.vault
      .delete(selectedPath)
      .then(() => {
        setSelectedPath(null)
        setFileContent(null)
        setEditContent('')
        setIsDirty(false)
        handleRefresh()
      })
      .catch(() => {
        setError('Failed to delete file')
      })
  }, [selectedPath, handleRefresh])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
    },
    [handleSave]
  )

  if (!visible) return <div className="deck-terminal--hidden" />

  if (error && !contentRoot) {
    return (
      <div className="deck-files">
        <div className="deck-md-empty">{error}</div>
      </div>
    )
  }

  const hasFile = selectedPath && fileContent !== null

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
        <button className="deck-files-btn" onClick={handleRefresh} title="Refresh tree">
          &#8635;
        </button>
        {contentRoot && <SearchBar contentRoot={contentRoot} onSelect={handleFileSelect} />}
        {hasFile && (
          <button className="deck-wiki-delete-btn" onClick={handleDelete} title="Delete file">
            &#x1F5D1;
          </button>
        )}
        {isMd && hasFile && (
          <div className="deck-wiki-mode-btns">
            <button
              className={`deck-wiki-mode-btn${viewMode === 'preview' ? ' active' : ''}`}
              onClick={() => setViewMode('preview')}
              title="Preview"
            >
              Preview
            </button>
            <button
              className={`deck-wiki-mode-btn${viewMode === 'split' ? ' active' : ''}`}
              onClick={() => setViewMode('split')}
              title="Split"
            >
              Split
            </button>
            <button
              className={`deck-wiki-mode-btn${viewMode === 'edit' ? ' active' : ''}`}
              onClick={() => setViewMode('edit')}
              title="Edit"
            >
              Edit
            </button>
          </div>
        )}
        {isMd && hasFile && (viewMode === 'edit' || viewMode === 'split') && (
          <div className="deck-wiki-save-area">
            {isDirty && <span className="deck-wiki-dirty-dot" title="Unsaved changes" />}
            <button
              className="deck-wiki-save-btn"
              onClick={handleSave}
              disabled={!isDirty}
              title="Save (Ctrl+S)"
            >
              Save
            </button>
            {saveStatus === 'saved' && <span className="deck-wiki-save-status">Saved</span>}
            {saveStatus === 'error' && (
              <span className="deck-wiki-save-status error">Save failed</span>
            )}
          </div>
        )}
        {error && <span className="deck-files-error">{error}</span>}
      </div>
      <div className="deck-files-split">
        <div className="deck-files-tree">
          {loading ? (
            <div className="deck-ftree-empty">Loading...</div>
          ) : (
            <FileTree
              nodes={tree}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              onSelect={handleFileSelect}
              onToggle={handleToggle}
            />
          )}
        </div>
        <div className={`deck-files-content${viewMode === 'split' ? ' wiki-split' : ''}`}>
          {hasFile ? (
            <>
              {(viewMode === 'edit' || viewMode === 'split') && isMd && (
                <div className="deck-wiki-editor-pane">
                  <textarea
                    className="deck-wiki-textarea"
                    value={editContent}
                    onChange={(e) => handleEditChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    spellCheck={false}
                  />
                </div>
              )}
              {viewMode === 'split' && (
                <div className="deck-wiki-preview-pane">
                  <MarkdownViewer
                    content={editContent}
                    filePath={selectedPath}
                    onWikilinkClick={handleWikilinkClick}
                    onRelativeLinkClick={handleFileSelect}
                  />
                </div>
              )}
              {viewMode === 'preview' &&
                (isMd ? (
                  <MarkdownViewer
                    content={fileContent}
                    filePath={selectedPath}
                    onWikilinkClick={handleWikilinkClick}
                    onRelativeLinkClick={handleFileSelect}
                  />
                ) : (
                  <div className="deck-md">
                    <div className="deck-md-header">
                      <span className="deck-md-filename">{selectedPath.split(/[/\\]/).pop()}</span>
                    </div>
                    <div className="deck-md-body">
                      <pre style={{ color: '#888', fontSize: 13 }}>{fileContent}</pre>
                    </div>
                  </div>
                ))}
            </>
          ) : (
            <div className="deck-md-empty">Select a file to view</div>
          )}
        </div>
      </div>
    </div>
  )
}

export default FilesView
