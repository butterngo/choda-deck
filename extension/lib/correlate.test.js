// Matching a relayed body to its webRequest record.
const { pickRecordForBody, MAX_SKEW_MS } = require('./correlate.js')

const rec = (over) => ({ url: 'https://api.x/p', method: 'GET', ts: 1000, ...over })

describe('pickRecordForBody', () => {
  it('matches the single obvious record', () => {
    const r = rec({ requestId: '1' })
    expect(pickRecordForBody([r], { url: 'https://api.x/p', method: 'GET' })).toBe(r)
  })

  it('ignores records for a different url or method', () => {
    const records = [rec({ requestId: '1', url: 'https://api.x/other' }), rec({ requestId: '2', method: 'POST' })]
    expect(pickRecordForBody(records, { url: 'https://api.x/p', method: 'GET' })).toBeNull()
  })

  it('ignores records that already carry a body', () => {
    const records = [rec({ requestId: '1', body: 'taken' })]
    expect(pickRecordForBody(records, { url: 'https://api.x/p', method: 'GET' })).toBeNull()
  })

  // The regression this module exists for: three identical in-flight requests whose
  // responses land out of order. Newest-first would give A's body to C.
  it('routes each body to the call that started it, regardless of completion order', () => {
    const a = rec({ requestId: 'a', ts: 1000 })
    const b = rec({ requestId: 'b', ts: 1200 })
    const c = rec({ requestId: 'c', ts: 1400 })
    const records = [a, b, c]

    const first = pickRecordForBody(records, { url: 'https://api.x/p', method: 'GET', startedAt: 1001 })
    expect(first).toBe(a)
    first.body = 'A'

    const second = pickRecordForBody(records, { url: 'https://api.x/p', method: 'GET', startedAt: 1401 })
    expect(second).toBe(c)
    second.body = 'C'

    const third = pickRecordForBody(records, { url: 'https://api.x/p', method: 'GET', startedAt: 1201 })
    expect(third).toBe(b)
  })

  it('without a timestamp, falls back to the OLDEST unclaimed record (FIFO)', () => {
    const a = rec({ requestId: 'a', ts: 1000 })
    const c = rec({ requestId: 'c', ts: 1400 })
    expect(pickRecordForBody([c, a], { url: 'https://api.x/p', method: 'GET' })).toBe(a)
  })

  it('refuses a match beyond the skew ceiling rather than guessing', () => {
    const stale = rec({ requestId: 'stale', ts: 1000 })
    const msg = { url: 'https://api.x/p', method: 'GET', startedAt: 1000 + MAX_SKEW_MS + 1 }
    expect(pickRecordForBody([stale], msg)).toBeNull()
  })

  it('matches when the method is absent from the message', () => {
    const r = rec({ requestId: '1' })
    expect(pickRecordForBody([r], { url: 'https://api.x/p', startedAt: 1000 })).toBe(r)
  })

  it('handles no records and malformed messages', () => {
    expect(pickRecordForBody([], { url: 'https://api.x/p' })).toBeNull()
    expect(pickRecordForBody([rec({})], null)).toBeNull()
    expect(pickRecordForBody([rec({})], { url: undefined })).toBeNull()
  })
})
