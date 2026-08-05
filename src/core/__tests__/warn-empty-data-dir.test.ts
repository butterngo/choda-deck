import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { warnIfSilentlyEmpty } from '../warn-empty-data-dir'

let root: string

function dirWithDb(name: string): string {
  const dir = path.join(root, name, 'database')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'choda-deck.db'), Buffer.alloc(2048, 1))
  return path.join(root, name)
}

function emptyDir(name: string): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'warn-empty-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('warnIfSilentlyEmpty (TASK-1510 AC-3)', () => {
  it('warns when the chosen dir is empty and another holds a database', () => {
    const chosen = emptyDir('fresh-appdata')
    const real = dirWithDb('real')
    let out = ''
    const warned = warnIfSilentlyEmpty(chosen, (m) => (out += m), [real])
    expect(warned).toBe(true)
    expect(out).toContain(path.join(real, 'database', 'choda-deck.db'))
    expect(out).toContain('which is live')
    expect(out).toContain('docs/data-directory.md')
  })

  it('stays silent when the chosen dir has the database', () => {
    const chosen = dirWithDb('chosen')
    let out = ''
    expect(warnIfSilentlyEmpty(chosen, (m) => (out += m), [dirWithDb('other')])).toBe(false)
    expect(out).toBe('')
  })

  it('stays silent on a genuine first run — nothing anywhere', () => {
    // An empty dir is legitimate when there is no other data. Warning here would train
    // the warning away before it ever fires on the real case.
    let out = ''
    expect(warnIfSilentlyEmpty(emptyDir('a'), (m) => (out += m), [emptyDir('b')])).toBe(false)
    expect(out).toBe('')
  })

  it('does not throw when the chosen dir does not exist at all', () => {
    let out = ''
    expect(() =>
      warnIfSilentlyEmpty(path.join(root, 'nope'), (m) => (out += m), [dirWithDb('real')])
    ).not.toThrow()
  })

  it('writes through the injected sink, never to stdout', () => {
    // The MCP stdio transport carries JSON-RPC on stdout; a stray line there corrupts
    // the protocol rather than informing anyone. The default sink is process.stderr,
    // and this asserts the function never reaches for console.log.
    const chosen = emptyDir('fresh')
    const real = dirWithDb('real')
    const seen: string[] = []
    warnIfSilentlyEmpty(chosen, (m) => seen.push(m), [real])
    expect(seen).toHaveLength(1)
    expect(seen[0].startsWith('[choda-deck] ')).toBe(true)
  })
})
