const {
  resolveNetworkSource,
  resolveSessionSource,
  resolveTabSource,
  distinctPageUrls,
  UNKNOWN
} = require('./provenance')

// The bug this module exists for: records buffered from tab A, captured while the panel
// is bound to tab B. Every case below states what the artifact would have CLAIMED under
// the old activeTab-first behavior, since that is what made the wrong value dangerous.
const TAB_A = 'http://localhost:3002/admin/projects'
const TAB_B = 'https://timesheet.arp.mantu.com/'

const rec = (pageUrl) => ({ pageUrl })

describe('resolveNetworkSource', () => {
  it('prefers the record over the focused tab — the reported bug', () => {
    // Previously yielded TAB_B, asserting the timesheet page called a localhost api.
    expect(resolveNetworkSource([rec(TAB_A)], TAB_B)).toBe(TAB_A)
  })

  it('agrees with the focused tab when focus never moved', () => {
    expect(resolveNetworkSource([rec(TAB_A)], TAB_A)).toBe(TAB_A)
  })

  it('collapses several records from one page to that single page', () => {
    expect(resolveNetworkSource([rec(TAB_A), rec(TAB_A), rec(TAB_A)], TAB_B)).toBe(TAB_A)
  })

  it('names every page when a bundle spans more than one, instead of picking one', () => {
    const out = resolveNetworkSource([rec(TAB_A), rec(TAB_B)], TAB_B)
    expect(out).toContain(TAB_A)
    expect(out).toContain(TAB_B)
  })

  it('counts the overflow rather than listing every page in a title', () => {
    const pages = ['https://a.test/', 'https://b.test/', 'https://c.test/', 'https://d.test/']
    const out = resolveNetworkSource(pages.map(rec), null)
    expect(out).toBe('https://a.test/, https://b.test/ (+2 more)')
  })

  it('falls back to the focused tab when no record carries an origin', () => {
    expect(resolveNetworkSource([{ url: 'https://x.test/api' }], TAB_B)).toBe(TAB_B)
  })

  it("says 'unknown' rather than substituting something unrelated", () => {
    expect(resolveNetworkSource([rec('')], null)).toBe(UNKNOWN)
    expect(resolveNetworkSource([], undefined)).toBe(UNKNOWN)
    expect(resolveNetworkSource(null, '')).toBe(UNKNOWN)
  })

  it('ignores a blank pageUrl instead of letting it win over a real one', () => {
    // Order matters: the blank record is first, so a naive "take records[0]" would
    // report an empty origin while a real one sat in the selection.
    expect(resolveNetworkSource([rec('   '), rec(TAB_A)], TAB_B)).toBe(TAB_A)
  })
})

describe('resolveSessionSource', () => {
  it('uses the first nav event, not the first event', () => {
    // apicall events carry the REQUEST url, so events[0].url is a page url only by
    // luck of ordering — that is what the old fallback chain got wrong.
    const events = [
      { type: 'apicall', url: 'http://localhost:3002/api/admin/projects' },
      { type: 'nav', url: TAB_A }
    ]
    expect(resolveSessionSource(events, TAB_B)).toBe(TAB_A)
  })

  it('prefers the earliest nav when the session spans pages', () => {
    const events = [
      { type: 'nav', url: TAB_A },
      { type: 'nav', url: 'http://localhost:3002/admin/projects/6' }
    ]
    expect(resolveSessionSource(events, TAB_B)).toBe(TAB_A)
  })

  it('falls back to the focused tab when no nav event was recorded', () => {
    expect(resolveSessionSource([{ type: 'apicall', url: 'https://x.test/api' }], TAB_A)).toBe(TAB_A)
  })

  it("says 'unknown' when there is neither a nav event nor a focused tab", () => {
    expect(resolveSessionSource([], null)).toBe(UNKNOWN)
    expect(resolveSessionSource(null, undefined)).toBe(UNKNOWN)
  })
})

describe('distinctPageUrls', () => {
  it('dedupes while keeping first-seen order', () => {
    expect(distinctPageUrls([rec(TAB_B), rec(TAB_A), rec(TAB_B)])).toEqual([TAB_B, TAB_A])
  })

  it('trims so the same page written with stray whitespace is not counted twice', () => {
    expect(distinctPageUrls([rec(TAB_A), rec(` ${TAB_A} `)])).toEqual([TAB_A])
  })

  it('drops records with no usable pageUrl', () => {
    expect(distinctPageUrls([rec(undefined), rec(''), {}, null])).toEqual([])
  })
})

// TASK-1551 — the text/image half of the same bug. The panel binds activeTab once at
// init() and re-binds only on a tab SWITCH, so a same-tab navigation leaves it naming
// the previous page. Each case names what the artifact would have CLAIMED before.
describe('resolveTabSource', () => {
  const PAGE_BEFORE_NAV = 'http://localhost:3002/admin/projects'
  const PAGE_AT_CAPTURE = 'http://localhost:3002/admin/projects/6'

  it('uses the origin stamped when the content was captured', () => {
    expect(resolveTabSource(PAGE_AT_CAPTURE, PAGE_AT_CAPTURE)).toBe(PAGE_AT_CAPTURE)
  })

  it('keeps the capture-time origin when the user navigates before pressing Send', () => {
    // Pixels grabbed on /projects/6, Send pressed after navigating to /projects. The
    // send-time url is the wrong answer for content taken earlier.
    expect(resolveTabSource(PAGE_AT_CAPTURE, PAGE_BEFORE_NAV)).toBe(PAGE_AT_CAPTURE)
  })

  it('falls back to the send-time read for content with no capture moment', () => {
    // Hand-typed or pasted text: nothing was grabbed, so the focused tab is all there is.
    expect(resolveTabSource(null, PAGE_AT_CAPTURE)).toBe(PAGE_AT_CAPTURE)
  })

  it("says 'unknown' rather than inventing an origin", () => {
    // The reported defect — CONV-1785332788516-7, titled "Screenshot from unknown".
    // Honest, and deliberately preserved: a wrong url would read as a fact instead.
    expect(resolveTabSource(null, null)).toBe(UNKNOWN)
    expect(resolveTabSource(undefined, undefined)).toBe(UNKNOWN)
    expect(resolveTabSource('', '')).toBe(UNKNOWN)
  })

  it('treats a blank stamp as absent and defers to the send-time read', () => {
    expect(resolveTabSource('   ', PAGE_BEFORE_NAV)).toBe(PAGE_BEFORE_NAV)
  })

  it('trims both inputs', () => {
    expect(resolveTabSource(` ${PAGE_AT_CAPTURE} `, null)).toBe(PAGE_AT_CAPTURE)
    expect(resolveTabSource(null, ` ${PAGE_BEFORE_NAV} `)).toBe(PAGE_BEFORE_NAV)
  })

  it('ignores non-string inputs instead of stringifying them', () => {
    // A tab object passed by mistake must not become "[object Object]" as an origin.
    expect(resolveTabSource({ url: PAGE_AT_CAPTURE }, null)).toBe(UNKNOWN)
    expect(resolveTabSource(null, 42)).toBe(UNKNOWN)
  })
})
