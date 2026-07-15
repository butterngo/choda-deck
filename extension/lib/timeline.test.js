// TASK-1414 — session buffer. Pure, node env.
const { createSession } = require('./timeline.js')

const bigShot = (id, kb) => ({ id, html: '<p>x</p>', screenshotDataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(kb * 1024) })

describe('timeline correlation (AC-2)', () => {
  it('merges events into one ts-sorted timeline', () => {
    const s = createSession()
    s.addEvent({ type: 'apicall', ts: 30, method: 'POST' })
    s.addEvent({ type: 'nav', ts: 10, url: 'a' })
    s.addEvent({ type: 'click', ts: 20, selector: '#x' })
    const { bundle } = s.finalize({ projectId: 'choda-deck' })
    expect(bundle.events.map((e) => e.ts)).toEqual([10, 20, 30])
    expect(bundle.startedAt).toBe(10)
    expect(bundle.endedAt).toBe(30)
  })
})

describe('empty-session guard (AC-4)', () => {
  it('no events → empty, no bundle', () => {
    const s = createSession()
    expect(s.finalize({ projectId: 'p' })).toMatchObject({ bundle: null, empty: true })
  })
  it('only a lone seed nav → still empty', () => {
    const s = createSession()
    s.addEvent({ type: 'nav', ts: 1, url: 'a' })
    expect(s.finalize({ projectId: 'p' }).empty).toBe(true)
  })
  it('a nav + a click → not empty', () => {
    const s = createSession()
    s.addEvent({ type: 'nav', ts: 1, url: 'a' })
    s.addEvent({ type: 'click', ts: 2, selector: '#x' })
    expect(s.finalize({ projectId: 'p' }).empty).toBe(false)
  })
})

describe('size-cap degradation (AC-5)', () => {
  it('drops oldest screenshots to fit the cap, keeps all behavior events', () => {
    const s = createSession()
    s.addEvent({ type: 'nav', ts: 1, url: 'a' })
    s.addEvent({ type: 'click', ts: 2, selector: '#x' })
    s.addEvent({ type: 'apicall', ts: 3, method: 'GET' })
    s.addSnapshot(bigShot('snap-1', 400))
    s.addSnapshot(bigShot('snap-2', 400))
    s.addSnapshot(bigShot('snap-3', 400))
    // 3 x ~400KB screenshots ≈ 1.2MB > a 600KB test cap
    const { bundle, trimmed, bytes } = s.finalize({ projectId: 'p', maxBytes: 600 * 1024 })
    expect(bytes).toBeLessThanOrEqual(600 * 1024)
    expect(trimmed).toBeGreaterThan(0)
    // behavior events all survive
    expect(bundle.events).toHaveLength(3)
    // at least one screenshot dropped; html kept on every snapshot
    expect(bundle.snapshots.every((s2) => s2.html)).toBe(true)
    const withShot = bundle.snapshots.filter((s2) => s2.screenshotDataUrl).length
    expect(withShot).toBeLessThan(3)
  })
})
