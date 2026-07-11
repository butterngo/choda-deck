import { describe, it, expect } from 'vitest'
import { parseNetworkRecord, formatNetworkRecord } from './capture-artifacts'

describe('network record — response body (TASK-1370)', () => {
  const base = { method: 'GET', url: 'https://api.x/me', status: 200 }

  it('parses and renders a response body when present', () => {
    const rec = parseNetworkRecord({ ...base, body: '{"role":"admin"}' })
    expect(rec.body).toBe('{"role":"admin"}')
    const md = formatNetworkRecord(rec)
    expect(md).toContain('**Response body**')
    expect(md).toContain('{"role":"admin"}')
  })

  it('omits the body section when absent', () => {
    const md = formatNetworkRecord(parseNetworkRecord(base))
    expect(md).not.toContain('Response body')
  })

  it('caps an oversize body at 64 KB', () => {
    const rec = parseNetworkRecord({ ...base, body: 'x'.repeat(70 * 1024) })
    expect(rec.body?.length).toBe(64 * 1024)
  })

  it('ignores a non-string body', () => {
    const rec = parseNetworkRecord({ ...base, body: { not: 'a string' } })
    expect(rec.body).toBeUndefined()
  })
})
