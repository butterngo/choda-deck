import { describe, it, expect } from 'vitest'
import { pgSuiteMode, suiteForMode, type SuiteApi } from './postgres-harness'

// TASK-2474 — on Linux CI a failed Docker detection fails the pg suite instead of
// skipping it; everywhere else it still skips.

const failed = { ok: false, error: 'spawnSync docker ETIMEDOUT' }
const ok = { ok: true, error: null }

describe('pgSuiteMode — TASK-2474', () => {
  it('linux + CI + detection failed → fail', () => {
    expect(pgSuiteMode({ ci: true, platform: 'linux', docker: failed })).toBe('fail')
  })

  it('linux + CI + ok → run', () => {
    expect(pgSuiteMode({ ci: true, platform: 'linux', docker: ok })).toBe('run')
  })

  it('win32 + CI + detection failed → skip', () => {
    expect(pgSuiteMode({ ci: true, platform: 'win32', docker: failed })).toBe('skip')
  })

  it('linux + no CI + detection failed → skip', () => {
    expect(pgSuiteMode({ ci: false, platform: 'linux', docker: failed })).toBe('skip')
  })
})

/** Records what the wrapper registers instead of registering it with vitest. */
function stubApi(): { api: SuiteApi; calls: string[]; tests: Array<() => void> } {
  const calls: string[] = []
  const tests: Array<() => void> = []
  const api: SuiteApi = {
    describe: (name, fn) => {
      calls.push(`describe:${name}`)
      fn()
    },
    skip: (name) => {
      calls.push(`skip:${name}`)
    },
    it: (name, fn) => {
      calls.push(`it:${name}`)
      tests.push(fn)
    }
  }
  return { api, calls, tests }
}

describe('suiteForMode — TASK-2474', () => {
  it('fail mode registers a test that throws the detection error, not a skip', () => {
    const { api, calls, tests } = stubApi()
    suiteForMode('fail', failed.error, api)('PostgresCounterRepository', () => {
      throw new Error('the real suite body must not run without Docker')
    })

    expect(calls.some((c) => c.startsWith('skip:'))).toBe(false)
    expect(tests).toHaveLength(1)
    expect(tests[0]).toThrow('Docker detection failed on Linux CI — spawnSync docker ETIMEDOUT')
  })

  it('skip mode skips and run mode describes', () => {
    const skip = stubApi()
    suiteForMode('skip', failed.error, skip.api)('S', () => {})
    expect(skip.calls).toEqual(['skip:S'])

    const run = stubApi()
    suiteForMode('run', null, run.api)('R', () => {})
    expect(run.calls).toEqual(['describe:R'])
  })
})
