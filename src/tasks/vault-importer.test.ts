import { describe, it, expect } from 'vitest'
import { parseConversationThreads, parseHandoffFile } from './vault-importer'

describe('parseConversationThreads', () => {
  it('parses a single CLOSED thread with replies', () => {
    const md = `# Conversation — Test

## #1 API response shape — CLOSED

**Date:** 2026-04-10
**To:** FE team
**Context:** BE returns large payload. Need FE input on what to keep.

Some more detail about the problem.

**FE reply — 2026-04-10:**

We only need \`data\` and \`status\`.

**BE reply — 2026-04-10 — CLOSED:**

Applied. Stripped extra fields.

---
`
    const threads = parseConversationThreads(md)
    expect(threads).toHaveLength(1)

    const t = threads[0]
    expect(t.number).toBe(1)
    expect(t.title).toBe('API response shape')
    expect(t.closed).toBe(true)
    expect(t.date).toBe('2026-04-10')
    expect(t.participants).toContain('FE team')
    expect(t.participants).toContain('FE')
    expect(t.participants).toContain('BE')

    expect(t.messages).toHaveLength(3)
    expect(t.messages[0].type).toBe('question')
    expect(t.messages[0].content).toContain('BE returns large payload')
    expect(t.messages[1].author).toBe('FE')
    expect(t.messages[1].type).toBe('answer')
    expect(t.messages[2].author).toBe('BE')
  })

  it('parses multiple threads', () => {
    const md = `# Conversations

## #2 Feature X — OPEN

**Date:** 2026-04-11
**To:** Dev
**Context:** Should we add caching?

---

## #1 Bug Y — CLOSED

**Date:** 2026-04-10
**To:** QA
**Context:** Crash on null input.

---
`
    const threads = parseConversationThreads(md)
    expect(threads).toHaveLength(2)
    expect(threads[0].number).toBe(2)
    expect(threads[0].closed).toBe(false)
    expect(threads[1].number).toBe(1)
    expect(threads[1].closed).toBe(true)
  })

  it('returns empty for file with no threads', () => {
    expect(parseConversationThreads('# Just a title\n\nNo threads here.')).toEqual([])
  })
})

describe('parseHandoffFile', () => {
  it('parses a standard handoff with frontmatter', () => {
    const md = `---
date: 2026-04-14
project: test-proj
---

# Session Handoff

## What was done

- Implemented feature A
- Fixed bug B

## Decisions made

- Use option 1 for caching
- Keep legacy API

## Resume point

Start with TASK-100 integration testing.

## Loose ends

- Stash from last week
- Untracked docs folder
`
    const result = parseHandoffFile(md)
    expect(result).not.toBeNull()
    expect(result!.date).toBe('2026-04-14')
    expect(result!.commits).toEqual(['Implemented feature A', 'Fixed bug B'])
    expect(result!.decisions).toEqual(['Use option 1 for caching', 'Keep legacy API'])
    expect(result!.resumePoint).toContain('TASK-100')
    expect(result!.looseEnds).toEqual(['Stash from last week', 'Untracked docs folder'])
  })

  it('handles "What was accomplished" variant', () => {
    const md = `---
date: 2026-04-15
---

## What was accomplished

- Shipped v2

## Open / Next

Deploy to staging next.
`
    const result = parseHandoffFile(md)
    expect(result).not.toBeNull()
    expect(result!.commits).toEqual(['Shipped v2'])
    expect(result!.resumePoint).toContain('Deploy to staging')
  })

  it('returns null for unparseable content', () => {
    expect(parseHandoffFile('')).not.toBeNull() // empty but valid
  })

  it('extracts blockers as looseEnds', () => {
    const md = `---
date: 2026-04-14
---

## Blockers

- Waiting on API key
- DB migration pending
`
    const result = parseHandoffFile(md)
    expect(result!.looseEnds).toEqual(['Waiting on API key', 'DB migration pending'])
  })
})
