// TASK-1412 — behavior recorder. Node env; stub elements (no real DOM needed).
const { createRecorder } = require('./recorder.js')

function makeEl(props) {
  return { getAttribute: () => null, ...props }
}

function setup() {
  const events = []
  let t = 0
  const rec = createRecorder({ emit: (e) => events.push(e), now: () => ++t, url: () => 'https://ex/p' })
  return { rec, events }
}

describe('recorder record-state (AC-5)', () => {
  it('emits nothing while idle', () => {
    const { rec, events } = setup()
    rec.handleDomEvent({ type: 'click', target: makeEl({ tagName: 'BUTTON', id: 'b' }) })
    rec.handleNav('https://ex/x')
    expect(events).toHaveLength(0)
  })

  it('stops emitting after stop()', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleNav('https://ex/x')
    rec.stop()
    rec.handleNav('https://ex/y')
    expect(events).toHaveLength(1)
  })
})

describe('recorder events (AC-1)', () => {
  it('click → click event with selector + trimmed text + ts + url', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleDomEvent({ type: 'click', target: makeEl({ tagName: 'BUTTON', id: 'buy', innerText: '  Buy now  ' }) })
    expect(events[0]).toMatchObject({ type: 'click', selector: '#buy', text: 'Buy now', url: 'https://ex/p' })
    expect(typeof events[0].ts).toBe('number')
  })

  it('input on a password field → value redacted (AC-3, uses ChodaRedact)', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleDomEvent({ type: 'input', target: makeEl({ tagName: 'INPUT', id: 'pw', type: 'password', value: 'hunter2' }) })
    expect(events[0]).toMatchObject({ type: 'input', selector: '#pw', value: '[redacted]' })
    expect(events[0].value).not.toContain('hunter2')
  })

  it('input on a plain field → keeps the value', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleDomEvent({ type: 'input', target: makeEl({ tagName: 'INPUT', id: 'city', type: 'text', value: 'Hanoi' }) })
    expect(events[0].value).toBe('Hanoi')
  })

  it('handleNav → nav event (SPA pushState path, AC-4)', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleNav('https://ex/spa/route', 'Route')
    expect(events[0]).toMatchObject({ type: 'nav', url: 'https://ex/spa/route', title: 'Route' })
  })
})
