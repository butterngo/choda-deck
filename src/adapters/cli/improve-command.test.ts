import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { bridgeTokenEnv } from './improve-command'

// TASK-2399 — the measure's app must reach token-gated reads like the packaged
// app does, or every page logs a 401 nobody sees in real use.
describe('bridgeTokenEnv (TASK-2399)', () => {
  const dataDir = path.join('C:', 'data')
  const file = path.join(dataDir, 'bridge-token.txt')

  it('points the started app at <dataDir>/bridge-token.txt when it exists', () => {
    expect(bridgeTokenEnv(dataDir, {}, (f) => f === file)).toEqual({
      CHODA_BRIDGE_TOKEN_FILE: file
    })
  })

  it('adds nothing when the profile has no token file', () => {
    expect(bridgeTokenEnv(dataDir, {}, () => false)).toEqual({})
  })

  it('never overrides a token or token file the caller already set', () => {
    expect(bridgeTokenEnv(dataDir, { CHODA_BRIDGE_TOKEN: 'x' }, () => true)).toEqual({})
    expect(bridgeTokenEnv(dataDir, { CHODA_BRIDGE_TOKEN_FILE: 'y' }, () => true)).toEqual({})
  })
})
