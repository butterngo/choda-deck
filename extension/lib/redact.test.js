// TASK-1411 — redaction util. Pure functions, no DOM (fields are plain stubs).
const { redactValue, redactText, redactHeaders, REDACTED } = require('./redact.js')

describe('redactValue (AC-1)', () => {
  it.each([
    ['password type', { type: 'password', value: 'hunter2' }, REDACTED],
    ['hidden type', { type: 'hidden', value: 'csrf-abc' }, REDACTED],
    ['name=cc-number', { type: 'text', name: 'cc-number', value: '4111111111111111' }, REDACTED],
    ['autocomplete=cc-csc', { type: 'text', autocomplete: 'cc-csc', value: '123' }, REDACTED],
    ['id contains ssn', { type: 'text', id: 'user-ssn', value: '123-45-6789' }, REDACTED],
    ['plain text field', { type: 'text', name: 'city', value: 'Hanoi' }, 'Hanoi'],
    ['email field kept', { type: 'email', name: 'email', value: 'a@b.com' }, 'a@b.com']
  ])('%s → %s', (_label, field, expected) => {
    expect(redactValue(field)).toBe(expected)
  })

  it('caps very long values', () => {
    const long = 'x'.repeat(2000)
    expect(redactValue({ type: 'text', value: long }).length).toBeLessThanOrEqual(512)
  })
})

describe('redactText (AC-2)', () => {
  it('masks a JWT inside surrounding text', () => {
    const jwt = 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4'
    const out = redactText(`token is ${jwt} ok`)
    expect(out).not.toContain(jwt)
    expect(out).toContain(REDACTED)
    expect(out).toContain('token is')
    expect(out).toContain('ok')
  })
  it('masks a Bearer header value and an api-key assignment', () => {
    expect(redactText('Bearer abcDEF123456ghijkl')).toBe(REDACTED)
    const out = redactText('api_key=SUPERSECRETVALUE1234 and city=Hanoi')
    expect(out).not.toContain('SUPERSECRETVALUE1234')
    expect(out).toContain('city=Hanoi')
  })
  it('leaves non-secret text untouched', () => {
    expect(redactText('just a normal sentence with words')).toBe('just a normal sentence with words')
  })
})

describe('redactHeaders (AC-3)', () => {
  it('strips auth/cookie headers case-insensitively, keeps the rest', () => {
    const out = redactHeaders({
      Authorization: 'Bearer x',
      COOKIE: 'sid=1',
      'X-Api-Key': 'k',
      'content-type': 'application/json'
    })
    expect(out.Authorization).toBe(REDACTED)
    expect(out.COOKIE).toBe(REDACTED)
    expect(out['X-Api-Key']).toBe(REDACTED)
    expect(out['content-type']).toBe('application/json')
  })
})
