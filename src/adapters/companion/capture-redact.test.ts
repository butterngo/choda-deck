// TASK-3155 — the pure redaction applied to every network capture at parse time.
import { describe, it, expect } from 'vitest'
import { REDACTED, redactNetworkRecord } from './capture-redact'

const SECRET = 'zz_test_secret_0001'

describe('redactNetworkRecord (TASK-3155)', () => {
  it('masks Authorization but leaves Accept untouched, keeping both names', () => {
    const out = redactNetworkRecord({
      method: 'GET',
      url: 'https://api.x/me',
      requestHeaders: { Authorization: `Bearer ${SECRET}`, Accept: 'text/html' }
    })
    expect(out.requestHeaders).toEqual({ Authorization: REDACTED, Accept: 'text/html' })
  })

  it.each(['Proxy-Authorization', 'COOKIE', 'Set-Cookie', 'X-Api-Key', 'x-auth-token'])(
    'masks the response header %s (mixed case) and keeps its name',
    (name) => {
      const out = redactNetworkRecord({
        method: 'GET',
        url: 'https://api.x/me',
        responseHeaders: { [name]: SECRET, 'content-type': 'text/plain' }
      })
      expect(out.responseHeaders?.[name]).toBe(REDACTED)
      expect(out.responseHeaders?.['content-type']).toBe('text/plain')
    }
  )

  it('masks every cookie value and keeps the names', () => {
    const out = redactNetworkRecord({
      method: 'GET',
      url: 'https://api.x/me',
      cookies: { sid: 'zz_test_cookie_0001', theme: 'dark' }
    })
    expect(out.cookies).toEqual({ sid: REDACTED, theme: REDACTED })
  })

  it('masks a JSON access_token in the body and keeps the rest readable', () => {
    const out = redactNetworkRecord({
      method: 'POST',
      url: 'https://api.x/login',
      body: '{"access_token":"zz_test_token_00000001","user":"bob"}'
    })
    expect(out.body).not.toContain('zz_test_token_00000001')
    expect(out.body).toContain('"user":"bob"')
    expect(out.body).toContain(REDACTED)
  })

  it('masks a three-segment JWT in the request body', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmn'
    const out = redactNetworkRecord({
      method: 'POST',
      url: 'https://api.x/refresh',
      reqBody: `grant=${jwt}&keep=me`
    })
    expect(out.reqBody).not.toContain(jwt)
    expect(out.reqBody).toContain('keep=me')
  })

  it('is pure: method/url/status unchanged and the input record untouched', () => {
    const input = {
      method: 'GET',
      url: 'https://api.x/me?token=notours',
      status: 200,
      requestHeaders: { authorization: SECRET }
    }
    const out = redactNetworkRecord(input)
    expect(out).toMatchObject({ method: 'GET', url: 'https://api.x/me?token=notours', status: 200 })
    expect(input.requestHeaders.authorization).toBe(SECRET)
    expect(out).not.toBe(input)
  })
})
