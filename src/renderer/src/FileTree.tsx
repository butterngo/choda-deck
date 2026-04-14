import { useState } from 'react'

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

interface FileTreeProps {
  nodes: FileNode[]
  selectedPath: string | null
  onSelect: (path: string) => void
}

interface FileTreeNodeProps {
  node: FileNode
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
}

function FileTreeNode({ node, depth, selectedPath, onSelect }: FileTreeNodeProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(depth < 1)

  if (node.type === 'directory') {
    return (
      <div className="deck-ftree-dir">
        <button
          className="deck-ftree-row deck-ftree-row--dir"
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="deck-ftree-arrow">{expanded ? '\u25BE' : '\u25B8'}</span>
          <span className="deck-ftree-icon">&#128193;</span>
          <span className="deck-ftree-name">{node.name}</span>
        </button>
        {expanded && node.children && (
          <div className="deck-ftree-children">
            {node.children.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  const isSelected = node.path === selectedPath
  const ext = node.name.split('.').pop()?.toLowerCase()
  const icon = ext === 'md' ? '\u{1F4C4}' : '\u{1F4CB}'

  return (
    <button
      className={`deck-ftree-row deck-ftree-row--file${isSelected ? ' deck-ftree-row--selected' : ''}`}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
      onClick={() => onSelect(node.path)}
    >
      <span className="deck-ftree-icon">{icon}</span>
      <span className="deck-ftree-name">{node.name}</span>
    </button>
  )
}

function FileTree({ nodes, selectedPath, onSelect }: FileTreeProps): React.JSX.Element {
  return (
    <div className="deck-ftree">
      {nodes.length === 0 && (
        <div className="deck-ftree-empty">No files found</div>
      )}
      {nodes.map((node) => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

export default FileTree
