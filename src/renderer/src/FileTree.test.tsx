// @vitest-environment jsdom
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

describe('FileTree', () => {
  it('renders top-level nodes', () => {
    render(<FileTree nodes={SAMPLE_TREE} selectedPath={null} onSelect={() => {}} />)

    expect(screen.getByText('10-Projects')).toBeDefined()
    expect(screen.getByText('20-Areas')).toBeDefined()
    expect(screen.getByText('readme.txt')).toBeDefined()
  })

  it('shows empty message when no nodes', () => {
    render(<FileTree nodes={[]} selectedPath={null} onSelect={() => {}} />)

    expect(screen.getByText('No files found')).toBeDefined()
  })

  it('auto-expands top-level directories', () => {
    render(<FileTree nodes={SAMPLE_TREE} selectedPath={null} onSelect={() => {}} />)

    // depth=0 directories are auto-expanded, so children should be visible
    expect(screen.getByText('project-a.md')).toBeDefined()
    expect(screen.getByText('tasks')).toBeDefined()
  })

  it('does not auto-expand nested directories', () => {
    render(<FileTree nodes={SAMPLE_TREE} selectedPath={null} onSelect={() => {}} />)

    // "tasks" is depth=1, collapsed by default — TASK-001.md should not be visible
    expect(screen.queryByText('TASK-001.md')).toBeNull()
  })

  it('expands nested directory on click', () => {
    render(<FileTree nodes={SAMPLE_TREE} selectedPath={null} onSelect={() => {}} />)

    // Click "tasks" folder to expand
    fireEvent.click(screen.getByText('tasks'))

    expect(screen.getByText('TASK-001.md')).toBeDefined()
  })

  it('collapses directory on second click', () => {
    render(<FileTree nodes={SAMPLE_TREE} selectedPath={null} onSelect={() => {}} />)

    // Expand then collapse "tasks"
    fireEvent.click(screen.getByText('tasks'))
    expect(screen.getByText('TASK-001.md')).toBeDefined()

    fireEvent.click(screen.getByText('tasks'))
    expect(screen.queryByText('TASK-001.md')).toBeNull()
  })

  it('calls onSelect when file is clicked', () => {
    const onSelect = vi.fn()
    render(<FileTree nodes={SAMPLE_TREE} selectedPath={null} onSelect={onSelect} />)

    fireEvent.click(screen.getByText('project-a.md'))

    expect(onSelect).toHaveBeenCalledWith('/vault/10-Projects/project-a.md')
  })

  it('does not call onSelect when directory is clicked', () => {
    const onSelect = vi.fn()
    render(<FileTree nodes={SAMPLE_TREE} selectedPath={null} onSelect={onSelect} />)

    fireEvent.click(screen.getByText('10-Projects'))

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('applies selected class to selected file', () => {
    render(
      <FileTree
        nodes={SAMPLE_TREE}
        selectedPath="/vault/10-Projects/project-a.md"
        onSelect={() => {}}
      />
    )

    const btn = screen.getByText('project-a.md').closest('button')
    expect(btn?.className).toContain('deck-ftree-row--selected')
  })

  it('does not apply selected class to non-selected files', () => {
    render(
      <FileTree
        nodes={SAMPLE_TREE}
        selectedPath="/vault/10-Projects/project-a.md"
        onSelect={() => {}}
      />
    )

    const btn = screen.getByText('readme.txt').closest('button')
    expect(btn?.className).not.toContain('deck-ftree-row--selected')
  })
})
