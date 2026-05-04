import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadSessionRules } from './session-rules-loader'

function makeTmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-rules-'))
  const path = join(dir, 'session-rules.md')
  writeFileSync(path, content)
  return path
}

describe('loadSessionRules', () => {
  let path: string

  beforeEach(() => {
    path = ''
  })

  it('parses all 4 sections in order', () => {
    path = makeTmpFile(`# Session Rules

## On session_start

Step 1
Step 2

## On session_checkpoint

Checkpoint A

## On session_resume

Resume A

## On session_end

Bullet A
Bullet B
`)
    const rules = loadSessionRules(path)
    expect(rules.sessionStart).toBe('Step 1\nStep 2')
    expect(rules.sessionCheckpoint).toBe('Checkpoint A')
    expect(rules.sessionResume).toBe('Resume A')
    expect(rules.sessionEnd).toBe('Bullet A\nBullet B')
  })

  it('parses sections in reverse order', () => {
    path = makeTmpFile(`## On session_end

End first

## On session_resume

Resume second

## On session_checkpoint

Checkpoint third

## On session_start

Start fourth
`)
    const rules = loadSessionRules(path)
    expect(rules.sessionStart).toBe('Start fourth')
    expect(rules.sessionCheckpoint).toBe('Checkpoint third')
    expect(rules.sessionResume).toBe('Resume second')
    expect(rules.sessionEnd).toBe('End first')
  })

  it('returns empty strings when file missing', () => {
    const rules = loadSessionRules('/nonexistent/path/rules.md')
    expect(rules.sessionStart).toBe('')
    expect(rules.sessionCheckpoint).toBe('')
    expect(rules.sessionResume).toBe('')
    expect(rules.sessionEnd).toBe('')
  })

  it('returns empty for missing section but keeps present ones', () => {
    path = makeTmpFile(`## On session_start

Only start exists

## On session_resume

Resume exists too
`)
    const rules = loadSessionRules(path)
    expect(rules.sessionStart).toBe('Only start exists')
    expect(rules.sessionCheckpoint).toBe('')
    expect(rules.sessionResume).toBe('Resume exists too')
    expect(rules.sessionEnd).toBe('')
  })

  it('ignores unrelated heading levels', () => {
    path = makeTmpFile(`# Title

### Sub heading
not a section

## On session_start

Real content
`)
    const rules = loadSessionRules(path)
    expect(rules.sessionStart).toBe('Real content')
  })

  it('hot-reload: second read after edit returns new content', () => {
    path = makeTmpFile(`## On session_start\n\nv1\n\n## On session_end\n\ne1\n`)
    const first = loadSessionRules(path)
    expect(first.sessionStart).toBe('v1')

    writeFileSync(path, `## On session_start\n\nv2\n\n## On session_end\n\ne2\n`)
    const second = loadSessionRules(path)
    expect(second.sessionStart).toBe('v2')
    expect(second.sessionEnd).toBe('e2')
  })

  it('handles CRLF line endings', () => {
    path = makeTmpFile(
      `## On session_start\r\n\r\nStep 1\r\n\r\n## On session_end\r\n\r\nEnd step\r\n`
    )
    const rules = loadSessionRules(path)
    expect(rules.sessionStart).toBe('Step 1')
    expect(rules.sessionEnd).toBe('End step')
  })
})
