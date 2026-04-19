import { useEffect, useRef, useState } from 'react'

export type Priority = 'critical' | 'high' | 'medium' | 'low'

const PRIORITIES: Priority[] = ['critical', 'high', 'medium', 'low']

interface PriorityPickerProps {
  value: string | null
  onChange: (next: Priority) => void
  disabled?: boolean
}

function PriorityPicker({ value, onChange, disabled }: PriorityPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState<number>(() => {
    const idx = PRIORITIES.indexOf(value as Priority)
    return idx >= 0 ? idx : 0
  })
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return

    function handlePointerDown(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }

    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor((c) => (c + 1) % PRIORITIES.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => (c - 1 + PRIORITIES.length) % PRIORITIES.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const pick = PRIORITIES[cursor]
        setOpen(false)
        if (pick !== value) onChange(pick)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, cursor, value, onChange])

  function toggle(e: React.MouseEvent): void {
    e.stopPropagation()
    if (disabled) return
    const idx = PRIORITIES.indexOf(value as Priority)
    setCursor(idx >= 0 ? idx : 0)
    setOpen((v) => !v)
  }

  function pick(p: Priority, e: React.MouseEvent): void {
    e.stopPropagation()
    setOpen(false)
    if (p !== value) onChange(p)
  }

  const badgeClass = value
    ? `deck-kanban-badge deck-kanban-badge--${value}`
    : 'deck-kanban-badge deck-priority-picker__empty'
  const label = value ?? 'priority'

  return (
    <div
      ref={rootRef}
      className={`deck-priority-picker${open ? ' deck-priority-picker--open' : ''}`}
    >
      <button
        type="button"
        className={badgeClass}
        onClick={toggle}
        disabled={disabled}
        title={value ? `Change priority (${value})` : 'Set priority'}
      >
        {label}
      </button>
      {open && (
        <div className="deck-priority-picker__menu" role="listbox">
          {PRIORITIES.map((p, i) => (
            <button
              key={p}
              type="button"
              role="option"
              aria-selected={p === value}
              className={
                `deck-priority-picker__option` +
                (p === value ? ' deck-priority-picker__option--current' : '') +
                (i === cursor ? ' deck-priority-picker__option--cursor' : '')
              }
              onMouseEnter={() => setCursor(i)}
              onClick={(e) => pick(p, e)}
            >
              <span className={`deck-priority-picker__chip deck-priority-picker__chip--${p}`} />
              <span className="deck-priority-picker__label">{p}</span>
              {p === value && <span className="deck-priority-picker__check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default PriorityPicker
