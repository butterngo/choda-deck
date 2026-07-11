import { describe, it, expect } from 'vitest'
import { validateCapture, CAPTURE_MAX_TEXT_BYTES, CAPTURE_MAX_IMAGE_BYTES } from './capture-contract'

describe('validateCapture', () => {
  const valid = { kind: 'text', destination: 'inbox', payload: 'hello', sourceUrl: 'http://x' }

  it('accepts a well-formed capture and returns the typed value', () => {
    const result = validateCapture(valid)
    expect(result).toEqual({ ok: true, value: valid })
  })

  it('accepts every kind × destination combination', () => {
    for (const kind of ['text', 'image', 'network']) {
      for (const destination of ['inbox', 'task', 'conversation', 'knowledge']) {
        expect(validateCapture({ ...valid, kind, destination }).ok).toBe(true)
      }
    }
  })

  it.each([
    ['non-object body', 42],
    ['null body', null],
    ['bad kind', { ...valid, kind: 'video' }],
    ['bad destination', { ...valid, destination: 'nowhere' }],
    ['missing payload', { kind: 'text', destination: 'inbox', sourceUrl: 'http://x' }],
    ['null payload', { ...valid, payload: null }],
    ['missing sourceUrl', { kind: 'text', destination: 'inbox', payload: 'x' }],
    ['empty sourceUrl', { ...valid, sourceUrl: '' }]
  ])('rejects %s', (_label, body) => {
    const result = validateCapture(body)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })

  it('does not validate per-kind payload shape (dispatcher owns that)', () => {
    // an image kind with a plain string payload is contract-valid here
    expect(validateCapture({ ...valid, kind: 'image' }).ok).toBe(true)
  })

  it('exposes a 64 KB text cap and a larger image cap', () => {
    expect(CAPTURE_MAX_TEXT_BYTES).toBe(64 * 1024)
    expect(CAPTURE_MAX_IMAGE_BYTES).toBeGreaterThan(CAPTURE_MAX_TEXT_BYTES)
  })
})
