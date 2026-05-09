import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadMcpRules } from './mcp-rules-loader'

function makeTmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-rules-'))
  const path = join(dir, 'mcp-rules.md')
  writeFileSync(path, content)
  return path
}

describe('loadMcpRules', () => {
  let path: string

  beforeEach(() => {
    path = ''
  })

  it('parses all 5 sections in order', () => {
    path = makeTmpFile(`# MCP Rules

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

## On conversation_read

Etiquette A
`)
    const rules = loadMcpRules(path)
    expect(rules.sessionStart).toBe('Step 1\nStep 2')
    expect(rules.sessionCheckpoint).toBe('Checkpoint A')
    expect(rules.sessionResume).toBe('Resume A')
    expect(rules.sessionEnd).toBe('Bullet A\nBullet B')
    expect(rules.conversationRead).toBe('Etiquette A')
  })

  it('parses sections in reverse order', () => {
    path = makeTmpFile(`## On conversation_read

Etiquette zero

## On session_end

End first

## On session_resume

Resume second

## On session_checkpoint

Checkpoint third

## On session_start

Start fourth
`)
    const rules = loadMcpRules(path)
    expect(rules.sessionStart).toBe('Start fourth')
    expect(rules.sessionCheckpoint).toBe('Checkpoint third')
    expect(rules.sessionResume).toBe('Resume second')
    expect(rules.sessionEnd).toBe('End first')
    expect(rules.conversationRead).toBe('Etiquette zero')
  })

  it('returns empty strings when file missing', () => {
    const rules = loadMcpRules('/nonexistent/path/rules.md')
    expect(rules.sessionStart).toBe('')
    expect(rules.sessionCheckpoint).toBe('')
    expect(rules.sessionResume).toBe('')
    expect(rules.sessionEnd).toBe('')
    expect(rules.conversationRead).toBe('')
  })

  it('returns empty for missing section but keeps present ones', () => {
    path = makeTmpFile(`## On session_start

Only start exists

## On conversation_read

Etiquette only
`)
    const rules = loadMcpRules(path)
    expect(rules.sessionStart).toBe('Only start exists')
    expect(rules.sessionCheckpoint).toBe('')
    expect(rules.sessionResume).toBe('')
    expect(rules.sessionEnd).toBe('')
    expect(rules.conversationRead).toBe('Etiquette only')
  })

  it('ignores unrelated heading levels', () => {
    path = makeTmpFile(`# Title

### Sub heading
not a section

## On session_start

Real content
`)
    const rules = loadMcpRules(path)
    expect(rules.sessionStart).toBe('Real content')
  })

  it('hot-reload: second read after edit returns new content', () => {
    path = makeTmpFile(`## On session_start\n\nv1\n\n## On session_end\n\ne1\n`)
    const first = loadMcpRules(path)
    expect(first.sessionStart).toBe('v1')

    writeFileSync(path, `## On session_start\n\nv2\n\n## On session_end\n\ne2\n`)
    const second = loadMcpRules(path)
    expect(second.sessionStart).toBe('v2')
    expect(second.sessionEnd).toBe('e2')
  })

  it('handles CRLF line endings', () => {
    path = makeTmpFile(
      `## On session_start\r\n\r\nStep 1\r\n\r\n## On session_end\r\n\r\nEnd step\r\n`
    )
    const rules = loadMcpRules(path)
    expect(rules.sessionStart).toBe('Step 1')
    expect(rules.sessionEnd).toBe('End step')
  })

  it('parses ## On conversation_read section with multi-line content', () => {
    path = makeTmpFile(`## On conversation_read

Etiquette guidance:
- bullet 1
- bullet 2
`)
    const rules = loadMcpRules(path)
    expect(rules.conversationRead).toBe('Etiquette guidance:\n- bullet 1\n- bullet 2')
  })
})
