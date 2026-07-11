import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resolveBridgeToken, BRIDGE_TOKEN_FILE } from './bridge-token'

describe('resolveBridgeToken', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-token-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('mints and persists a token on first use', () => {
    const token = resolveBridgeToken(dir)
    expect(token.length).toBeGreaterThanOrEqual(32)
    const onDisk = fs.readFileSync(path.join(dir, BRIDGE_TOKEN_FILE), 'utf8').trim()
    expect(onDisk).toBe(token)
  })

  it('returns the same token on a second call (stable per profile)', () => {
    expect(resolveBridgeToken(dir)).toBe(resolveBridgeToken(dir))
  })

  it('re-mints when the token file is present but empty', () => {
    const tokenPath = path.join(dir, BRIDGE_TOKEN_FILE)
    fs.writeFileSync(tokenPath, '   ')
    const token = resolveBridgeToken(dir)
    expect(token.trim().length).toBeGreaterThan(0)
    expect(fs.readFileSync(tokenPath, 'utf8').trim()).toBe(token)
  })

  it('creates the data dir if it does not exist', () => {
    const nested = path.join(dir, 'a', 'b')
    const token = resolveBridgeToken(nested)
    expect(fs.existsSync(path.join(nested, BRIDGE_TOKEN_FILE))).toBe(true)
    expect(token.length).toBeGreaterThan(0)
  })
})
