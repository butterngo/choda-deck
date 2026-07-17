// TASK-1423 — noise filter. Node env; plain objects, no DOM.
const {
  DEFAULT_EXCLUDE_PATTERNS,
  isExcluded,
  collapseKey,
  createCollapser
} = require('./noise-filter.js')

describe('isExcluded — telemetry deny-list (AC-1, AC-2)', () => {
  // The three real noise URLs from the INBOX-1172 recording.
  it.each([
    'https://westeurope-5.in.applicationinsights.azure.com/v2/track',
    'https://js.monitor.azure.com/scripts/c/ai.config.json',
    'https://dc.services.visualstudio.com/v2/track'
  ])('drops the observed telemetry URL %s', (url) => {
    expect(isExcluded(url)).toBe(true)
  })

  it.each([
    'https://google-analytics.com/collect',
    'https://o123.ingest.sentry.io/api/1/envelope',
    'https://cdn.mxpnl.com/../mixpanel.com/track'
  ])('drops common analytics/RUM beacon %s', (url) => {
    expect(isExcluded(url)).toBe(true)
  })

  it.each([
    'https://abook.mantu.com/ABookApi/api/Templates/GetEmployeeThumbnail?Id=7',
    'https://api.shop.ex/cart',
    'https://api.shop.ex/v2/track-order', // "track" alone must NOT match
    'https://api.shop.ex/analytics-report' // an app's OWN analytics screen is real
  ])('keeps the business URL %s', (url) => {
    expect(isExcluded(url)).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isExcluded('https://JS.MONITOR.AZURE.COM/x')).toBe(true)
  })

  it('treats a malformed/empty url as not-noise (handleNetwork rejects it separately)', () => {
    expect(isExcluded('')).toBe(false)
    expect(isExcluded(undefined)).toBe(false)
    expect(isExcluded(123)).toBe(false)
  })

  it('honors a caller-supplied pattern list', () => {
    expect(isExcluded('https://api.shop.ex/cart', ['shop.ex'])).toBe(true)
    expect(isExcluded('https://js.monitor.azure.com/x', ['shop.ex'])).toBe(false)
  })

  it('ships a non-empty documented default list (AC-2)', () => {
    expect(DEFAULT_EXCLUDE_PATTERNS.length).toBeGreaterThan(0)
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain('applicationinsights.azure.com')
  })
})

describe('collapseKey — query-normalized identity', () => {
  it('folds differing query strings onto one key', () => {
    const a = collapseKey('GET', 'https://x.ex/api/Thumb?Id=1')
    const b = collapseKey('GET', 'https://x.ex/api/Thumb?Id=2&cache=0')
    expect(a).toBe(b)
  })

  it('separates different paths, hosts and methods', () => {
    const base = collapseKey('GET', 'https://x.ex/api/Thumb?Id=1')
    expect(collapseKey('GET', 'https://x.ex/api/Other?Id=1')).not.toBe(base)
    expect(collapseKey('GET', 'https://y.ex/api/Thumb?Id=1')).not.toBe(base)
    expect(collapseKey('POST', 'https://x.ex/api/Thumb?Id=1')).not.toBe(base)
  })

  it('normalizes method case and defaults to GET', () => {
    expect(collapseKey('get', 'https://x.ex/a')).toBe(collapseKey('GET', 'https://x.ex/a'))
    expect(collapseKey(undefined, 'https://x.ex/a')).toBe(collapseKey('GET', 'https://x.ex/a'))
  })

  it('degrades without throwing on an unparseable url', () => {
    expect(() => collapseKey('GET', '/relative/path?x=1')).not.toThrow()
    expect(collapseKey('GET', '/relative/path?x=1')).toBe(collapseKey('GET', '/relative/path?x=2'))
  })
})

describe('createCollapser — asset fan-out folding (AC-3)', () => {
  const call = (url, method) => ({ type: 'apicall', url, method: method || 'GET' })

  it('admits the first call and folds the rest into its count', () => {
    const c = createCollapser()
    const first = call('https://x.ex/api/Thumb?Id=1')
    expect(c.admit(first)).toBe(true)
    expect(c.admit(call('https://x.ex/api/Thumb?Id=2'))).toBe(false)
    expect(c.admit(call('https://x.ex/api/Thumb?Id=3'))).toBe(false)
    expect(first.collapsed).toBe(3)
  })

  it('retains sample urls so the collapsed ids stay legible, capped', () => {
    const c = createCollapser()
    const first = call('https://x.ex/api/Thumb?Id=1')
    c.admit(first)
    for (let i = 2; i <= 10; i++) c.admit(call(`https://x.ex/api/Thumb?Id=${i}`))
    expect(first.collapsed).toBe(10)
    expect(first.collapsedSamples).toHaveLength(5)
    expect(first.collapsedSamples[0]).toContain('Id=1')
    expect(first.collapsedSamples[4]).toContain('Id=5')
  })

  it('leaves a lone call unmarked — no collapsed field on a single hit', () => {
    const c = createCollapser()
    const only = call('https://x.ex/api/Cart')
    expect(c.admit(only)).toBe(true)
    expect(only.collapsed).toBeUndefined()
    expect(only.collapsedSamples).toBeUndefined()
  })

  it('keeps distinct endpoints independent', () => {
    const c = createCollapser()
    expect(c.admit(call('https://x.ex/api/Cart'))).toBe(true)
    expect(c.admit(call('https://x.ex/api/Orders'))).toBe(true)
    expect(c.admit(call('https://x.ex/api/Cart', 'POST'))).toBe(true)
  })

  it('never folds a non-apicall event', () => {
    const c = createCollapser()
    expect(c.admit({ type: 'nav', url: 'https://x.ex/p' })).toBe(true)
    expect(c.admit({ type: 'nav', url: 'https://x.ex/p' })).toBe(true)
  })

  it('reset() clears state so a second recording starts fresh', () => {
    const c = createCollapser()
    const first = call('https://x.ex/api/Thumb?Id=1')
    c.admit(first)
    c.reset()
    const second = call('https://x.ex/api/Thumb?Id=2')
    expect(c.admit(second)).toBe(true)
    expect(second.collapsed).toBeUndefined()
  })
})
