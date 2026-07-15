// @vitest-environment happy-dom
// TASK-1413 — DOM snapshotter. Needs a DOM for serialize (happy-dom).
require('./redact.js') // side-effect: sets globalThis.ChodaRedact for snapshot.js
const { shouldSnapshot, serializeDom, takeSnapshot, MAX_HTML_BYTES } = require('./snapshot.js')

describe('trigger policy (AC-2)', () => {
  it.each([
    ['nav', true],
    ['click', true],
    ['input', false],
    ['change', false],
    ['apicall', false]
  ])('shouldSnapshot(%s) === %s', (type, expected) => {
    expect(shouldSnapshot(type)).toBe(expected)
  })
})

describe('serializeDom redaction (AC-1)', () => {
  it('masks a seeded token in the DOM html', () => {
    document.body.innerHTML = '<div data-token="SECRET_zzz_123456">cart</div><style>.x{color:red}</style>'
    const { html } = serializeDom(document)
    expect(html).not.toContain('SECRET_zzz_123456')
    expect(html).toContain('[redacted]')
    expect(html).toContain('cart')
  })
})

describe('takeSnapshot (AC-1, AC-3)', () => {
  it('returns a snapshot record + a snapshot timeline event referencing its id', () => {
    document.body.innerHTML = '<h1>Page</h1>'
    const { snapshot, event } = takeSnapshot({ doc: document, id: 's1', now: () => 42 })
    expect(snapshot.id).toBe('s1')
    expect(typeof snapshot.html).toBe('string')
    expect(event).toMatchObject({ type: 'snapshot', ts: 42, snapshotId: 's1' })
  })

  it('caps a huge DOM under the html byte budget (AC-3)', () => {
    document.body.innerHTML = '<p>' + 'x'.repeat(2 * 1024 * 1024) + '</p>'
    const { snapshot } = takeSnapshot({ doc: document, id: 'big' })
    expect(snapshot.html.length).toBeLessThanOrEqual(MAX_HTML_BYTES + 100)
    expect(snapshot.html).toContain('truncated')
  })

  it('includes a screenshotDataUrl when supplied by the caller (SW)', () => {
    document.body.innerHTML = '<h1>x</h1>'
    const { snapshot } = takeSnapshot({ doc: document, id: 's2', screenshotDataUrl: 'data:image/jpeg;base64,zz' })
    expect(snapshot.screenshotDataUrl).toBe('data:image/jpeg;base64,zz')
  })
})
