// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import DiffViewer from './DiffViewer'
import type { PipelineState } from '../../../core/harness/pipeline-state'

const STATE: PipelineState = {
  sessionId: 'SESSION-TEST',
  projectId: 'choda-deck',
  taskId: 'TASK-559',
  stage: 'generate',
  stageStatus: 'ready',
  currentIteration: 1,
  needsEvaluator: false,
  startedAt: '2026-04-21T11:00:00.000Z'
}

describe('DiffViewer', () => {
  it('renders placeholder when diff is empty', () => {
    render(<DiffViewer diff="" state={STATE} />)
    expect(screen.getByText('No diff produced.')).toBeDefined()
  })

  it('renders placeholder when diff is whitespace only', () => {
    render(<DiffViewer diff={'   \n\n  '} state={STATE} />)
    expect(screen.getByText('No diff produced.')).toBeDefined()
  })

  it('renders markdown heading from diff content', () => {
    render(<DiffViewer diff={'# Summary\n\nSome changes.'} state={STATE} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Summary' })).toBeDefined()
    expect(screen.getByText('Some changes.')).toBeDefined()
  })

  it('renders fenced code block with language class', () => {
    const diff = ['```diff', '- old', '+ new', '```'].join('\n')
    const { container } = render(<DiffViewer diff={diff} state={STATE} />)
    const code = container.querySelector('pre code')
    expect(code).toBeDefined()
    expect(code?.className).toMatch(/language-diff/)
  })

  it('renders fenced code block without language fence', () => {
    const diff = ['```', 'plain code', '```'].join('\n')
    const { container } = render(<DiffViewer diff={diff} state={STATE} />)
    const code = container.querySelector('pre code')
    expect(code).toBeDefined()
    expect(code?.textContent).toContain('plain code')
  })

  it('renders pipeline metadata from state', () => {
    render(<DiffViewer diff="# x" state={STATE} />)
    expect(screen.getByText('TASK-559')).toBeDefined()
    expect(screen.getByText('generate')).toBeDefined()
    expect(screen.getByText('ready')).toBeDefined()
    expect(screen.getByText('1')).toBeDefined()
  })

  it('handles a large diff without error', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const diff = `# Diff\n\n\`\`\`diff\n${lines}\n\`\`\``
    const { container } = render(<DiffViewer diff={diff} state={STATE} />)
    expect(container.querySelector('pre code')).toBeDefined()
  })
})
