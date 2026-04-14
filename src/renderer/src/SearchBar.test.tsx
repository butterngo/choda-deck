// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SearchBar from './SearchBar'

const MOCK_RESULTS = [
  {
    path: '/vault/10-Projects/context.md',
    name: 'context.md',
    matches: [{ line: 3, text: 'SQLite is the source of truth' }]
  },
  {
    path: '/vault/decisions/ADR-004.md',
    name: 'ADR-004.md',
    matches: [{ line: 1, text: '# ADR-004: SQLite for task management' }]
  }
]

function setupMockApi(searchResults = MOCK_RESULTS): void {
  window.api = {
    vault: {
      search: vi.fn().mockResolvedValue(searchResults),
      contentRoot: vi.fn().mockResolvedValue('/vault'),
      tree: vi.fn().mockResolvedValue([]),
      read: vi.fn().mockResolvedValue({ content: '', size: 0, mtime: '' }),
      resolve: vi.fn().mockResolvedValue(null)
    }
  } as unknown as typeof window.api
}

// Helper: type query and wait for search results to appear
async function typeAndWaitForResults(query: string): Promise<void> {
  fireEvent.change(screen.getByPlaceholderText('Search vault...'), {
    target: { value: query }
  })
  await waitFor(() => {
    expect(window.api.vault.search).toHaveBeenCalled()
  })
  await waitFor(() => {
    expect(screen.getByText('context.md')).toBeDefined()
  })
}

describe('SearchBar', () => {
  beforeEach(() => {
    setupMockApi()
  })

  it('renders search input', () => {
    render(<SearchBar contentRoot="/vault" onSelect={() => {}} />)
    expect(screen.getByPlaceholderText('Search vault...')).toBeDefined()
  })

  it('does not search with less than 2 characters', async () => {
    render(<SearchBar contentRoot="/vault" onSelect={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Search vault...'), {
      target: { value: 'S' }
    })

    // Wait a tick to ensure no search fires
    await new Promise((r) => setTimeout(r, 400))
    expect(window.api.vault.search).not.toHaveBeenCalled()
  })

  it('searches after debounce with 2+ characters', async () => {
    render(<SearchBar contentRoot="/vault" onSelect={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Search vault...'), {
      target: { value: 'SQLite' }
    })

    await waitFor(() => {
      expect(window.api.vault.search).toHaveBeenCalledWith('SQLite', '/vault')
    })
  })

  it('shows results dropdown', async () => {
    render(<SearchBar contentRoot="/vault" onSelect={() => {}} />)
    await typeAndWaitForResults('SQLite')

    expect(screen.getByText('ADR-004.md')).toBeDefined()
  })

  it('shows match preview in results', async () => {
    render(<SearchBar contentRoot="/vault" onSelect={() => {}} />)
    await typeAndWaitForResults('SQLite')

    expect(screen.getByText(/L3:.*SQLite is the source/)).toBeDefined()
  })

  it('calls onSelect when result is clicked', async () => {
    const onSelect = vi.fn()
    render(<SearchBar contentRoot="/vault" onSelect={onSelect} />)
    await typeAndWaitForResults('SQLite')

    fireEvent.click(screen.getByText('context.md'))

    expect(onSelect).toHaveBeenCalledWith('/vault/10-Projects/context.md')
  })

  it('clears input after selection', async () => {
    render(<SearchBar contentRoot="/vault" onSelect={() => {}} />)
    const input = screen.getByPlaceholderText('Search vault...') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'SQLite' } })

    await waitFor(() => {
      expect(screen.getByText('context.md')).toBeDefined()
    })

    fireEvent.click(screen.getByText('context.md'))
    expect(input.value).toBe('')
  })

  it('shows no results message', async () => {
    setupMockApi([])
    render(<SearchBar contentRoot="/vault" onSelect={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText('Search vault...'), {
      target: { value: 'zzz_nope' }
    })

    await waitFor(() => {
      expect(screen.getByText('No results')).toBeDefined()
    })
  })

  it('keyboard: ArrowDown + Enter selects result', async () => {
    const onSelect = vi.fn()
    render(<SearchBar contentRoot="/vault" onSelect={onSelect} />)

    const input = screen.getByPlaceholderText('Search vault...')
    await typeAndWaitForResults('SQLite')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith('/vault/10-Projects/context.md')
  })

  it('keyboard: Escape closes dropdown', async () => {
    render(<SearchBar contentRoot="/vault" onSelect={() => {}} />)

    const input = screen.getByPlaceholderText('Search vault...')
    await typeAndWaitForResults('SQLite')

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByText('context.md')).toBeNull()
  })
})
