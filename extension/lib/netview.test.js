// View-model helpers for the Network panel detail tabs.
const {
  generalRows,
  rawHeaderText,
  parseRequestCookies,
  parseResponseCookies
} = require('./netview.js')

describe('generalRows', () => {
  it('lists url + method + status', () => {
    expect(generalRows({ url: 'https://a/b', method: 'GET', status: 200 })).toEqual([
      ['Request URL', 'https://a/b'],
      ['Request Method', 'GET'],
      ['Status Code', '200']
    ])
  })

  it('omits the status row when the response was never seen', () => {
    const rows = generalRows({ url: 'https://a/b', method: 'GET' })
    expect(rows.map(([k]) => k)).not.toContain('Status Code')
  })

  it('includes referrer policy only when the header is present', () => {
    const withPolicy = generalRows({
      url: 'https://a/b',
      method: 'GET',
      requestHeaders: { 'referrer-policy': 'strict-origin-when-cross-origin' }
    })
    expect(withPolicy).toContainEqual(['Referrer Policy', 'strict-origin-when-cross-origin'])
    expect(generalRows({ url: 'https://a/b', method: 'GET' })).toHaveLength(2)
  })

  it('returns nothing for a missing record', () => {
    expect(generalRows(null)).toEqual([])
  })
})

describe('rawHeaderText', () => {
  it('renders one name: value per line', () => {
    expect(rawHeaderText({ accept: '*/*', 'content-type': 'application/json' })).toBe(
      'accept: */*\ncontent-type: application/json'
    )
  })

  it('is empty for no headers', () => {
    expect(rawHeaderText(undefined)).toBe('')
  })
})

describe('parseRequestCookies', () => {
  it('splits a Cookie header into pairs', () => {
    expect(parseRequestCookies({ cookie: 'a=1; b=2' })).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' }
    ])
  })

  it('splits on the first = only, so base64/JWT values survive intact', () => {
    expect(parseRequestCookies({ cookie: 'sid=eyJhbGc=.payload=' })).toEqual([
      { name: 'sid', value: 'eyJhbGc=.payload=' }
    ])
  })

  it('is empty when no Cookie header was captured', () => {
    expect(parseRequestCookies({})).toEqual([])
    expect(parseRequestCookies({ cookie: '' })).toEqual([])
  })
})

describe('parseResponseCookies', () => {
  it('extracts the pair plus its attributes', () => {
    expect(parseResponseCookies({ 'set-cookie': 'sid=abc; Path=/; HttpOnly' })).toEqual([
      { name: 'sid', value: 'abc', attributes: ['Path=/', 'HttpOnly'] }
    ])
  })

  it('handles a bare pair with no attributes', () => {
    expect(parseResponseCookies({ 'set-cookie': 'sid=abc' })).toEqual([
      { name: 'sid', value: 'abc', attributes: [] }
    ])
  })

  it('ignores a malformed header with no =', () => {
    expect(parseResponseCookies({ 'set-cookie': 'nonsense' })).toEqual([])
  })

  it('is empty when nothing was set', () => {
    expect(parseResponseCookies({})).toEqual([])
  })
})
