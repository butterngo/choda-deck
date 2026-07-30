import { describe, it, expect } from 'vitest'
import { parseNetworkRecord, formatNetworkRecord, buildHar } from './capture-artifacts'

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

describe('network record — request body', () => {
  const post = {
    method: 'POST',
    url: 'https://api.x/items',
    status: 201,
    requestHeaders: { 'content-type': 'application/json' }
  }

  it('parses and renders a request body when present', () => {
    const rec = parseNetworkRecord({ ...post, reqBody: '{"name":"a"}' })
    expect(rec.reqBody).toBe('{"name":"a"}')
    const md = formatNetworkRecord(rec)
    expect(md).toContain('**Request body**')
    expect(md).toContain('{"name":"a"}')
  })

  it('omits the request-body section when absent (GET / non-text body)', () => {
    const md = formatNetworkRecord(parseNetworkRecord(post))
    expect(md).not.toContain('Request body')
  })

  it('caps an oversize request body at 64 KB', () => {
    const rec = parseNetworkRecord({ ...post, reqBody: 'x'.repeat(70 * 1024) })
    expect(rec.reqBody?.length).toBe(64 * 1024)
  })

  it('a request body becomes HAR postData with the request content-type', () => {
    const har = JSON.parse(buildHar([parseNetworkRecord({ ...post, reqBody: '{"name":"a"}' })]))
    const request = har.log.entries[0].request
    expect(request.postData).toEqual({ mimeType: 'application/json', text: '{"name":"a"}' })
    expect(request.bodySize).toBe('{"name":"a"}'.length)
  })

  it('no request body → no postData key (HAR readers treat it as bodyless)', () => {
    const har = JSON.parse(buildHar([parseNetworkRecord(post)]))
    expect(har.log.entries[0].request.postData).toBeUndefined()
    expect(har.log.entries[0].request.bodySize).toBe(-1)
  })
})
