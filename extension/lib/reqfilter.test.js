// Request-list filtering + chip counting for the Network panel.
const { statusClass, matches, countForType } = require('./reqfilter.js')

const RECORDS = [
  { url: 'https://a/api/sources', method: 'GET', status: 200, resType: 'api', body: '{"ok":1}' },
  { url: 'https://a/api/sellers', method: 'GET', status: 200, resType: 'api' },
  { url: 'https://a/api/nodes', method: 'POST', status: 201, resType: 'api' },
  { url: 'https://a/api/missing', method: 'GET', status: 404, resType: 'api' },
  { url: 'https://a/page', method: 'GET', status: 200, resType: 'html' },
  { url: 'https://a/app.js', method: 'GET', status: 200, resType: 'js' }
]

const ALL = { type: 'all', method: 'all', statusClass: 'all', query: '' }

describe('statusClass', () => {
  it.each([
    [200, '2xx'],
    [301, '3xx'],
    [404, '4xx'],
    [500, '5xx']
  ])('%i → %s', (status, expected) => {
    expect(statusClass(status)).toBe(expected)
  })

  it('is null for an uncaptured or nonsense status', () => {
    expect(statusClass(undefined)).toBeNull()
    expect(statusClass(999)).toBeNull()
  })
})

describe('matches', () => {
  it('filters by type, method and status class', () => {
    expect(matches(RECORDS[0], { ...ALL, type: 'api' })).toBe(true)
    expect(matches(RECORDS[0], { ...ALL, type: 'js' })).toBe(false)
    expect(matches(RECORDS[2], { ...ALL, method: 'GET' })).toBe(false)
    expect(matches(RECORDS[3], { ...ALL, statusClass: '4xx' })).toBe(true)
    expect(matches(RECORDS[0], { ...ALL, statusClass: '4xx' })).toBe(false)
  })

  it('searches the url and the captured response body', () => {
    expect(matches(RECORDS[0], { ...ALL, query: 'sources' })).toBe(true)
    expect(matches(RECORDS[0], { ...ALL, query: '"ok"' })).toBe(true)
    expect(matches(RECORDS[1], { ...ALL, query: '"ok"' })).toBe(false)
  })

  it('treats a record with no resType as api', () => {
    expect(matches({ url: 'https://a/x', method: 'GET' }, { ...ALL, type: 'api' })).toBe(true)
  })
})

// The reported bug: chip read "API 25" above a 9-row list because the method
// filter was on GET and the chips ignored it.
describe('countForType', () => {
  it('counts what clicking the chip would actually show, honouring other filters', () => {
    expect(countForType(RECORDS, 'api', ALL)).toBe(4)
    expect(countForType(RECORDS, 'api', { ...ALL, method: 'GET' })).toBe(3)
    expect(countForType(RECORDS, 'api', { ...ALL, statusClass: '4xx' })).toBe(1)
    expect(countForType(RECORDS, 'api', { ...ALL, query: 'sellers' })).toBe(1)
  })

  it('the ALL chip counts every type under the same filters', () => {
    expect(countForType(RECORDS, 'all', ALL)).toBe(6)
    expect(countForType(RECORDS, 'all', { ...ALL, method: 'GET' })).toBe(5)
  })

  it('chip counts sum to the ALL count for the same filter state', () => {
    const f = { ...ALL, method: 'GET' }
    const perType = ['api', 'html', 'js', 'css'].reduce((n, t) => n + countForType(RECORDS, t, f), 0)
    expect(perType).toBe(countForType(RECORDS, 'all', f))
  })
})
