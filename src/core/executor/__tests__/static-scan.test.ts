import { describe, expect, it } from 'vitest'
import { scanSpec } from '../static-scan'

const CLEAN_SPEC = `import { test, expect } from '@playwright/test'

test('AC-1 login redirects to home', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByTestId('home-banner')).toBeVisible()
})
`

describe('scanSpec', () => {
  it('passes a clean spec', () => {
    const r = scanSpec(CLEAN_SPEC)
    expect(r.ok).toBe(true)
    expect(r.violations).toHaveLength(0)
  })

  it('rejects test.only', () => {
    const r = scanSpec(CLEAN_SPEC.replace("test('AC-1", "test.only('AC-1"))
    expect(r.ok).toBe(false)
    expect(r.violations[0].rule).toBe('test.only')
  })

  it('rejects test.skip', () => {
    const r = scanSpec(CLEAN_SPEC.replace("test('AC-1", "test.skip('AC-1"))
    expect(r.ok).toBe(false)
    expect(r.violations[0].rule).toBe('test.skip')
  })

  it('rejects --update-snapshots flag in comments', () => {
    const r = scanSpec(`// run with --update-snapshots\n${CLEAN_SPEC}`)
    expect(r.ok).toBe(false)
    expect(r.violations[0].rule).toBe('--update-snapshots flag')
  })

  it('rejects retries > 0', () => {
    const r = scanSpec(`test.describe.configure({ retries: 2 })\n${CLEAN_SPEC}`)
    expect(r.ok).toBe(false)
    expect(r.violations[0].rule).toBe('retries > 0')
  })

  it('allows retries: 0', () => {
    const r = scanSpec(`test.describe.configure({ retries: 0 })\n${CLEAN_SPEC}`)
    expect(r.ok).toBe(true)
  })

  it('rejects expect.soft without justify comment', () => {
    const r = scanSpec(CLEAN_SPEC.replace('expect(', 'expect.soft('))
    expect(r.ok).toBe(false)
    expect(r.violations[0].rule).toBe('expect.soft without // justify: comment')
  })

  it('allows expect.soft with adjacent justify comment', async () => {
    const spec = CLEAN_SPEC.replace(
      'await expect(',
      '// justify: animation delay tolerated\n  await expect.soft('
    )
    const r = scanSpec(spec)
    expect(r.ok).toBe(true)
  })
})
