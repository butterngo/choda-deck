// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import FilesView from './FilesView'

const MOCK_TREE = [
  {
    name: '10-Projects',
    path: '/vault/10-Projects',
    type: 'directory' as const,
    children: [{ name: 'context.md', path: '/vault/10-Projects/context.md', type: 'file' as const }]
  },
  { name: 'readme.md', path: '/vault/readme.md', type: 'file' as const }
]

const MOCK_CONTENT = '# Context\n\nThis is the project context with [[ADR-007]].'

function setupMockApi(overrides?: Partial<typeof window.api.vault>): void {
  window.api = {
    vault: {
      contentRoot: vi.fn().mockResolvedValue('/vault'),
      tree: vi.fn().mockResolvedValue(MOCK_TREE),
      read: vi
        .fn()
        .mockResolvedValue({ content: MOCK_CONTENT, size: 100, mtime: '2026-04-14T00:00:00Z' }),
      search: vi.fn().mockResolvedValue([]),
      resolve: vi.fn().mockResolvedValue('/vault/decisions/ADR-007.md'),
      ...overrides
    }
  } as unknown as typeof window.api
}

describe('FilesView', () => {
  beforeEach(() => {
    setupMockApi()
  })

  it('loads and renders file tree', async () => {
    render(<FilesView visible={true} />)

    await waitFor(() => {
      expect(screen.getByText('10-Projects')).toBeDefined()
      expect(screen.getByText('readme.md')).toBeDefined()
    })
  })

  it('shows placeholder when no file selected', async () => {
    render(<FilesView visible={true} />)

    await waitFor(() => {
      expect(screen.getByText('Select a file to view')).toBeDefined()
    })
  })

  it('loads file content when file is clicked', async () => {
    render(<FilesView visible={true} />)

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeDefined()
    })

    fireEvent.click(screen.getByText('readme.md'))

    await waitFor(() => {
      expect(window.api.vault.read).toHaveBeenCalledWith('/vault/readme.md')
    })
  })

  it('renders markdown content after file selection', async () => {
    render(<FilesView visible={true} />)

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeDefined()
    })

    fireEvent.click(screen.getByText('readme.md'))

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeDefined()
    })
  })

  it('shows error when contentRoot is empty', async () => {
    setupMockApi({ contentRoot: vi.fn().mockResolvedValue('') })

    render(<FilesView visible={true} />)

    await waitFor(() => {
      expect(screen.getByText('No contentRoot configured in projects.json')).toBeDefined()
    })
  })

  it('back button is disabled initially', async () => {
    render(<FilesView visible={true} />)

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeDefined()
    })

    const backBtn = screen.getByTitle('Back')
    expect(backBtn.hasAttribute('disabled')).toBe(true)
  })

  it('back button enabled after navigating', async () => {
    render(<FilesView visible={true} />)

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeDefined()
    })

    // Select first file
    fireEvent.click(screen.getByText('readme.md'))

    await waitFor(() => {
      expect(screen.getByText('Context')).toBeDefined()
    })

    // Expand 10-Projects dir, then select context.md
    fireEvent.click(screen.getByText('10-Projects'))
    fireEvent.click(screen.getByText('context.md'))

    await waitFor(() => {
      const backBtn = screen.getByTitle('Back')
      expect(backBtn.hasAttribute('disabled')).toBe(false)
    })
  })

  it('calls vault.resolve on wikilink click', async () => {
    render(<FilesView visible={true} />)

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeDefined()
    })

    fireEvent.click(screen.getByText('readme.md'))

    await waitFor(() => {
      expect(screen.getByText('ADR-007')).toBeDefined()
    })

    fireEvent.click(screen.getByText('ADR-007'))

    await waitFor(() => {
      expect(window.api.vault.resolve).toHaveBeenCalledWith('ADR-007', '/vault')
    })
  })

  it('returns hidden div when not visible', () => {
    const { container } = render(<FilesView visible={false} />)
    const root = container.firstElementChild
    expect(root?.className).toContain('deck-terminal--hidden')
  })

  it('refresh button reloads tree', async () => {
    render(<FilesView visible={true} />)

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeDefined()
    })

    fireEvent.click(screen.getByTitle('Refresh tree'))

    await waitFor(() => {
      expect(window.api.vault.tree).toHaveBeenCalledTimes(2)
    })
  })
})
