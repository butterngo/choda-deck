import { useState, useEffect, useRef, useCallback } from 'react'

export interface SearchResult {
  path: string
  name: string
  matches: Array<{ line: number; text: string }>
}

interface SearchBarProps {
  contentRoot: string
  onSelect: (path: string) => void
}

const DEBOUNCE_MS = 300

function SearchBar({ contentRoot, onSelect }: SearchBarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (query.length < 2) {
      setResults([])
      setOpen(false)
      return
    }

    debounceRef.current = setTimeout(() => {
      window.api.vault.search(query, contentRoot).then((res) => {
        setResults(res as SearchResult[])
        setOpen(true)
        setActiveIndex(-1)
      })
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, contentRoot])

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const handleSelect = useCallback((path: string) => {
    onSelect(path)
    setOpen(false)
    setQuery('')
    setResults([])
  }, [onSelect])

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (!open || results.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      handleSelect(results[activeIndex].path)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="deck-search" ref={containerRef}>
      <input
        className="deck-search-input"
        type="text"
        placeholder="Search vault..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => { if (results.length > 0) setOpen(true) }}
        onKeyDown={handleKeyDown}
      />
      {open && results.length > 0 && (
        <div className="deck-search-dropdown">
          {results.map((r, i) => (
            <button
              key={r.path}
              className={`deck-search-result${i === activeIndex ? ' deck-search-result--active' : ''}`}
              onClick={() => handleSelect(r.path)}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="deck-search-result-name">{r.name}</span>
              {r.matches[0] && (
                <span className="deck-search-result-match">
                  L{r.matches[0].line}: {r.matches[0].text.slice(0, 80)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {open && results.length === 0 && query.length >= 2 && (
        <div className="deck-search-dropdown">
          <div className="deck-search-empty">No results</div>
        </div>
      )}
    </div>
  )
}

export default SearchBar
