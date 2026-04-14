// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MarkdownViewer from './MarkdownViewer'

describe('MarkdownViewer', () => {
  it('renders markdown heading', () => {
    render(
      <MarkdownViewer
        content="# Hello World"
        filePath="/vault/test.md"
        onWikilinkClick={() => {}}
      />
    )

    expect(screen.getByRole('heading', { level: 1 })).toBeDefined()
    expect(screen.getByText('Hello World')).toBeDefined()
  })

  it('displays filename in header', () => {
    render(
      <MarkdownViewer
        content="# Test"
        filePath="/vault/10-Projects/my-file.md"
        onWikilinkClick={() => {}}
      />
    )

    expect(screen.getByText('my-file.md')).toBeDefined()
  })

  it('renders GFM tables', () => {
    const md = `| Col A | Col B |
| --- | --- |
| val1 | val2 |`

    render(
      <MarkdownViewer content={md} filePath="/test.md" onWikilinkClick={() => {}} />
    )

    expect(screen.getByText('Col A')).toBeDefined()
    expect(screen.getByText('val1')).toBeDefined()
  })

  it('renders GFM task lists', () => {
    const md = `- [x] Done item
- [ ] Todo item`

    render(
      <MarkdownViewer content={md} filePath="/test.md" onWikilinkClick={() => {}} />
    )

    expect(screen.getByText('Done item')).toBeDefined()
    expect(screen.getByText('Todo item')).toBeDefined()
  })

  it('renders inline code', () => {
    render(
      <MarkdownViewer
        content="Use `npm install` to install"
        filePath="/test.md"
        onWikilinkClick={() => {}}
      />
    )

    expect(screen.getByText('npm install')).toBeDefined()
  })

  it('renders wikilinks as clickable links', () => {
    render(
      <MarkdownViewer
        content="See [[ADR-007]] for details"
        filePath="/test.md"
        onWikilinkClick={() => {}}
      />
    )

    const link = screen.getByText('ADR-007')
    expect(link).toBeDefined()
    expect(link.tagName).toBe('A')
    expect(link.className).toContain('deck-md-wikilink')
  })

  it('calls onWikilinkClick when wikilink is clicked', () => {
    const onWikilinkClick = vi.fn()
    render(
      <MarkdownViewer
        content="See [[my-note]] for info"
        filePath="/test.md"
        onWikilinkClick={onWikilinkClick}
      />
    )

    fireEvent.click(screen.getByText('my-note'))

    expect(onWikilinkClick).toHaveBeenCalledWith('my-note')
  })

  it('renders multiple wikilinks in same paragraph', () => {
    render(
      <MarkdownViewer
        content="See [[note-a]] and [[note-b]] for more"
        filePath="/test.md"
        onWikilinkClick={() => {}}
      />
    )

    expect(screen.getByText('note-a')).toBeDefined()
    expect(screen.getByText('note-b')).toBeDefined()
  })

  it('renders text without wikilinks normally', () => {
    render(
      <MarkdownViewer
        content="Just a normal paragraph with no links."
        filePath="/test.md"
        onWikilinkClick={() => {}}
      />
    )

    expect(screen.getByText('Just a normal paragraph with no links.')).toBeDefined()
  })

  it('handles Windows paths in filePath', () => {
    render(
      <MarkdownViewer
        content="# Test"
        filePath="C:\\Users\\vault\\notes\\test.md"
        onWikilinkClick={() => {}}
      />
    )

    expect(screen.getByText('test.md')).toBeDefined()
  })
})
