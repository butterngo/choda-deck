// @vitest-environment jsdom
import type React from 'react'
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import FileTree from './FileTree'
import type { FileNode } from './FileTree'

const SAMPLE_TREE: FileNode[] = [
  {
    name: '10-Projects',
    path: '/vault/10-Projects',
    type: 'directory',
    children: [
      { name: 'project-a.md', path: '/vault/10-Projects/project-a.md', type: 'file' },
      {
        name: 'tasks',
        path: '/vault/10-Projects/tasks',
        type: 'directory',
        children: [
          { name: 'TASK-001.md', path: '/vault/10-Projects/tasks/TASK-001.md', type: 'file' }
        ]
      }
    ]
  },
  {
    name: '20-Areas',
    path: '/vault/20-Areas',
    type: 'directory',
    children: [{ name: 'goals.md', path: '/vault/20-Areas/goals.md', type: 'file' }]
  },
  { name: 'readme.txt', path: '/vault/readme.txt', type: 'file' }
]

const TOP_LEVEL_EXPANDED = new Set(['/vault/10-Projects', '/vault/20-Areas'])

interface HarnessProps {
  nodes: FileNode[]
  selectedPath?: string | null
  initialExpanded?: Set<string>
  onSelect?: (path: string) => void
}

function Harness({
  nodes,
  selectedPath = null,
  initialExpanded = TOP_LEVEL_EXPANDED,
  onSelect = (): void => {}
}: HarnessProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(initialExpanded)
  const onToggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  return (
    <FileTree
      nodes={nodes}
      selectedPath={selectedPath}
      expandedPaths={expanded}
      onSelect={onSelect}
      onToggle={onToggle}
    />
  )
}

describe('FileTree', () => {
  it('renders top-level nodes', () => {
    render(<Harness nodes={SAMPLE_TREE} />)

    expect(screen.getByText('10-Projects')).toBeDefined()
    expect(screen.getByText('20-Areas')).toBeDefined()
    expect(screen.getByText('readme.txt')).toBeDefined()
  })

  it('shows empty message when no nodes', () => {
    render(<Harness nodes={[]} />)

    expect(screen.getByText('No files found')).toBeDefined()
  })

  it('auto-expands top-level directories', () => {
    render(<Harness nodes={SAMPLE_TREE} />)

    expect(screen.getByText('project-a.md')).toBeDefined()
    expect(screen.getByText('tasks')).toBeDefined()
  })

  it('does not auto-expand nested directories', () => {
    render(<Harness nodes={SAMPLE_TREE} />)

    expect(screen.queryByText('TASK-001.md')).toBeNull()
  })

  it('expands nested directory on click', () => {
    render(<Harness nodes={SAMPLE_TREE} />)

    fireEvent.click(screen.getByText('tasks'))

    expect(screen.getByText('TASK-001.md')).toBeDefined()
  })

  it('collapses directory on second click', () => {
    render(<Harness nodes={SAMPLE_TREE} />)

    fireEvent.click(screen.getByText('tasks'))
    expect(screen.getByText('TASK-001.md')).toBeDefined()

    fireEvent.click(screen.getByText('tasks'))
    expect(screen.queryByText('TASK-001.md')).toBeNull()
  })

  it('calls onSelect when file is clicked', () => {
    const onSelect = vi.fn()
    render(<Harness nodes={SAMPLE_TREE} onSelect={onSelect} />)

    fireEvent.click(screen.getByText('project-a.md'))

    expect(onSelect).toHaveBeenCalledWith('/vault/10-Projects/project-a.md')
  })

  it('does not call onSelect when directory is clicked', () => {
    const onSelect = vi.fn()
    render(<Harness nodes={SAMPLE_TREE} onSelect={onSelect} />)

    fireEvent.click(screen.getByText('10-Projects'))

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('applies selected class to selected file', () => {
    render(<Harness nodes={SAMPLE_TREE} selectedPath="/vault/10-Projects/project-a.md" />)

    const btn = screen.getByText('project-a.md').closest('button')
    expect(btn?.className).toContain('deck-ftree-row--selected')
  })

  it('does not apply selected class to non-selected files', () => {
    render(<Harness nodes={SAMPLE_TREE} selectedPath="/vault/10-Projects/project-a.md" />)

    const btn = screen.getByText('readme.txt').closest('button')
    expect(btn?.className).not.toContain('deck-ftree-row--selected')
  })
})
