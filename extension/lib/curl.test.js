// cURL rendering + JSON pretty-print for the Network panel detail tabs.
const { shellQuote, buildCurl, prettyJson } = require('./curl.js')

describe('shellQuote', () => {
  it('wraps plain text in single quotes', () => {
    expect(shellQuote('abc')).toBe(`'abc'`)
  })

  it('escapes embedded single quotes as \'\\\'\'', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('leaves shell metacharacters inert inside the quotes', () => {
    expect(shellQuote('a$(rm -rf /)b')).toBe(`'a$(rm -rf /)b'`)
  })
})

describe('buildCurl', () => {
  it('a GET renders without an explicit -X', () => {
    const cmd = buildCurl({ method: 'GET', url: 'https://api.test/x', requestHeaders: {} })
    expect(cmd).toBe(`curl 'https://api.test/x'`)
  })

  it('a POST renders -X, headers, and --data-raw', () => {
    const cmd = buildCurl({
      method: 'POST',
      url: 'https://api.test/items',
      requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer tok' },
      reqBody: '{"a":1}'
    })
    expect(cmd).toContain(`-X POST`)
    expect(cmd).toContain(`-H 'content-type: application/json'`)
    expect(cmd).toContain(`-H 'authorization: Bearer tok'`)
    expect(cmd).toContain(`--data-raw '{"a":1}'`)
  })

  it('drops headers curl derives itself (host/content-length/connection)', () => {
    const cmd = buildCurl({
      method: 'GET',
      url: 'https://api.test/x',
      requestHeaders: { Host: 'api.test', 'Content-Length': '7', accept: '*/*' }
    })
    expect(cmd).not.toContain('Host')
    expect(cmd).not.toContain('Content-Length')
    expect(cmd).toContain(`-H 'accept: */*'`)
  })

  it('omits --data-raw when no request body was captured', () => {
    const cmd = buildCurl({ method: 'POST', url: 'https://api.test/x', requestHeaders: {} })
    expect(cmd).not.toContain('--data-raw')
  })

  it('continues lines with a trailing backslash', () => {
    const cmd = buildCurl({ method: 'GET', url: 'https://api.test/x', requestHeaders: { accept: '*/*' } })
    expect(cmd).toBe(`curl 'https://api.test/x' \\\n  -H 'accept: */*'`)
  })

  it('a record with no url yields an empty command', () => {
    expect(buildCurl({ method: 'GET' })).toBe('')
    expect(buildCurl(null)).toBe('')
  })
})

describe('prettyJson', () => {
  it('indents a JSON object', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
  })

  it('indents a JSON array', () => {
    expect(prettyJson('[1,2]')).toBe('[\n  1,\n  2\n]')
  })

  it('returns malformed JSON unchanged', () => {
    expect(prettyJson('{"a":')).toBe('{"a":')
  })

  it('leaves non-object bodies (html, scalars) alone', () => {
    expect(prettyJson('<html></html>')).toBe('<html></html>')
    expect(prettyJson('123')).toBe('123')
  })

  it('passes through non-strings', () => {
    expect(prettyJson(undefined)).toBeUndefined()
  })
})
