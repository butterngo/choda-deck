import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadAccountsConfig, AccountsConfigError } from './accounts-config'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-config-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadAccountsConfig', () => {
  it('missing file: every resolve returns null', () => {
    const cfg = loadAccountsConfig(tmpDir)
    expect(cfg.resolve('main')).toBeNull()
    expect(cfg.resolve('alt')).toBeNull()
  })

  it('malformed JSON throws AccountsConfigError', () => {
    fs.writeFileSync(path.join(tmpDir, 'accounts.json'), 'not json', 'utf8')
    expect(() => loadAccountsConfig(tmpDir)).toThrow(AccountsConfigError)
    expect(() => loadAccountsConfig(tmpDir)).toThrow('not valid JSON')
  })

  it('unknown name returns null', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'accounts.json'),
      JSON.stringify({ accounts: { main: '/home/user/.claude' } }),
      'utf8'
    )
    const cfg = loadAccountsConfig(tmpDir)
    expect(cfg.resolve('unknown')).toBeNull()
  })

  it('valid name resolves to the configured path', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'accounts.json'),
      JSON.stringify({
        accounts: {
          main: 'C:\\Users\\hngo1_mantu\\.claude',
          alt: 'C:\\Users\\hngo1_mantu\\.claude-alt'
        }
      }),
      'utf8'
    )
    const cfg = loadAccountsConfig(tmpDir)
    expect(cfg.resolve('main')).toBe('C:\\Users\\hngo1_mantu\\.claude')
    expect(cfg.resolve('alt')).toBe('C:\\Users\\hngo1_mantu\\.claude-alt')
  })
})
