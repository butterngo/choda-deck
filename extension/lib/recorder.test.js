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

  it('a click whose target yields no selector emits "unknown", never "" (TASK-1420 AC-2)', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleDomEvent({ type: 'click', target: { getAttribute: () => null } }) // no tagName
    expect(events[0]).toMatchObject({ type: 'click', selector: 'unknown' })
    expect(events[0].selector).not.toBe('')
  })

  it('handleNav → nav event (SPA pushState path, AC-4)', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleNav('https://ex/spa/route', 'Route')
    expect(events[0]).toMatchObject({ type: 'nav', url: 'https://ex/spa/route', title: 'Route' })
  })
})

describe('recorder network track (TASK-1419)', () => {
  it('handleNetwork emits an apicall only while recording (AC-1)', () => {
    const { rec, events } = setup()
    rec.handleNetwork({ url: 'https://api/x', method: 'GET', status: 200 })
    expect(events).toHaveLength(0) // idle
    rec.start()
    rec.handleNetwork({ url: 'https://api/x', method: 'POST', status: 201 })
    expect(events[0]).toMatchObject({ type: 'apicall', url: 'https://api/x', method: 'POST', status: 201 })
  })

  it('redacts a token in the response body and caps it (AC-2)', () => {
    const { rec, events } = setup()
    rec.start()
    const body = 'prefix Bearer abcDEF123456ghijkl {"tok":"eyJhbGciOi.eyJzdWIi.SflKxwRJ"} ' + 'x'.repeat(200000)
    rec.handleNetwork({ url: 'https://api/y', method: 'GET', status: 200, body })
    const ev = events[0]
    expect(ev.body).not.toContain('abcDEF123456ghijkl')
    expect(ev.body).toContain('[redacted]')
    expect(ev.body.length).toBeLessThanOrEqual(64 * 1024)
  })

  it('ignores a message with no url', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleNetwork({ method: 'GET' })
    expect(events).toHaveLength(0)
  })
})

// TASK-1424 — deeper API capture: request body + raised response cap.
describe('recorder deeper API capture (TASK-1424)', () => {
  it('a response body under the old 8 KB cap is no longer truncated (AC-1)', () => {
    const { rec, events } = setup()
    rec.start()
    const body = 'x'.repeat(20 * 1024)
    rec.handleNetwork({ url: 'https://api/y', method: 'GET', status: 200, body })
    expect(events[0].body).toHaveLength(20 * 1024)
  })

  it("a POST's request body is captured (redacted) into reqBody (AC-2)", () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleNetwork({
      url: 'https://api.ex/crawler/paging',
      method: 'POST',
      status: 200,
      body: '{"total":1}',
      reqBody: '{"page":1,"filters":{"token":"Bearer abcDEF123456ghijkl"}}'
    })
    expect(events[0].reqBody).toContain('"page":1')
    expect(events[0].reqBody).not.toContain('abcDEF123456ghijkl')
    expect(events[0].reqBody).toContain('[redacted]')
  })

  it('no reqBody on the message → reqBody stays undefined (GET requests)', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleNetwork({ url: 'https://api/y', method: 'GET', status: 200, body: '{}' })
    expect(events[0].reqBody).toBeUndefined()
  })
})

// TASK-1423 — noise gates wired into handleNetwork.
describe('recorder noise filter (TASK-1423)', () => {
  it('drops a telemetry apicall, keeps a business one (AC-1)', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleNetwork({ url: 'https://js.monitor.azure.com/scripts/c/ai.config.json', method: 'GET' })
    rec.handleNetwork({ url: 'https://westeurope-5.in.applicationinsights.azure.com/v2/track', method: 'POST' })
    rec.handleNetwork({ url: 'https://api.shop.ex/cart', method: 'POST', status: 201 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'apicall', url: 'https://api.shop.ex/cart' })
  })

  it('collapses an asset fan-out to one event carrying the count (AC-3)', () => {
    const { rec, events } = setup()
    rec.start()
    for (let i = 1; i <= 10; i++) {
      rec.handleNetwork({ url: `https://x.ex/ABookApi/api/Templates/GetEmployeeThumbnail?Id=${i}`, method: 'GET', status: 200 })
    }
    expect(events).toHaveLength(1)
    expect(events[0].collapsed).toBe(10)
    expect(events[0].collapsedSamples).toHaveLength(5)
  })

  it('replays the INBOX-1172 shape: 20 raw apicalls → 8 events (the task premise)', () => {
    const { rec, events } = setup()
    rec.start()
    // 3 telemetry beacons
    rec.handleNetwork({ url: 'https://westeurope-5.in.applicationinsights.azure.com/v2/track', method: 'POST' })
    rec.handleNetwork({ url: 'https://westeurope-5.in.applicationinsights.azure.com/v2/track', method: 'POST' })
    rec.handleNetwork({ url: 'https://js.monitor.azure.com/scripts/c/ai.config.json', method: 'GET' })
    // 10x avatar fan-out
    for (let i = 1; i <= 10; i++) {
      rec.handleNetwork({ url: `https://x.ex/ABookApi/api/Templates/GetEmployeeThumbnail?Id=${i}`, method: 'GET' })
    }
    // 7 distinct business endpoints
    const business = ['/api/Me', '/api/Employees', '/api/Employees/42', '/api/Teams', '/api/Skills', '/api/Assignments', '/api/Config']
    business.forEach((p) => rec.handleNetwork({ url: `https://x.ex${p}`, method: 'GET', status: 200 }))

    // 7 distinct + 1 collapsed thumbnail row = 8; the 3 beacons are gone.
    expect(events).toHaveLength(8)
    expect(events.filter((e) => e.collapsed)).toHaveLength(1)
    expect(events.some((e) => e.url.includes('applicationinsights'))).toBe(false)
  })

  it('collapse state resets between recordings', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleNetwork({ url: 'https://x.ex/api/Thumb?Id=1', method: 'GET' })
    rec.stop()
    rec.start()
    rec.handleNetwork({ url: 'https://x.ex/api/Thumb?Id=2', method: 'GET' })
    expect(events).toHaveLength(2)
    expect(events[0].collapsed).toBeUndefined()
  })

  it('opts.collapse === false keeps every raw apicall', () => {
    const events = []
    let t = 0
    const rec = createRecorder({ emit: (e) => events.push(e), now: () => ++t, url: () => 'https://ex/p', collapse: false })
    rec.start()
    rec.handleNetwork({ url: 'https://x.ex/api/Thumb?Id=1', method: 'GET' })
    rec.handleNetwork({ url: 'https://x.ex/api/Thumb?Id=2', method: 'GET' })
    expect(events).toHaveLength(2)
  })
})

// TASK-1461 — console capture.
describe('recorder console capture (TASK-1461)', () => {
  it('handleConsole emits a console event only while recording', () => {
    const { rec, events } = setup()
    rec.handleConsole({ level: 'error', message: 'boom' })
    expect(events).toHaveLength(0)
    rec.start()
    rec.handleConsole({ level: 'error', message: 'boom', stack: 'at f (x.js:1)' })
    expect(events[0]).toMatchObject({ type: 'console', level: 'error', message: 'boom', stack: 'at f (x.js:1)' })
    expect(typeof events[0].ts).toBe('number')
  })

  it('an unknown level normalizes to error; warn is preserved', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleConsole({ level: 'warn', message: 'careful' })
    rec.handleConsole({ level: 'info', message: 'whatever' })
    expect(events[0].level).toBe('warn')
    expect(events[1].level).toBe('error')
  })

  it('redacts secrets in message + stack (redactText)', () => {
    const { rec, events } = setup()
    rec.start()
    rec.handleConsole({
      level: 'error',
      message: 'auth failed token=abcDEF123456ghij',
      stack: 'Bearer abcDEF123456ghijklmnop at f'
    })
    expect(events[0].message).toContain('[redacted]')
    expect(events[0].message).not.toContain('abcDEF123456ghij')
    expect(events[0].stack).toContain('[redacted]')
  })

  it('caps runaway console volume and emits one dropped-count marker', () => {
    const { rec, events } = setup()
    rec.start()
    for (let i = 0; i < 130; i++) rec.handleConsole({ level: 'error', message: `e${i}` })
    // 100 real entries + exactly one marker
    expect(events).toHaveLength(101)
    const markers = events.filter((e) => e.message.includes('cap'))
    expect(markers).toHaveLength(1)
    expect(markers[0].level).toBe('warn')
  })

  it('console cap resets between recordings', () => {
    const { rec, events } = setup()
    rec.start()
    for (let i = 0; i < 100; i++) rec.handleConsole({ level: 'error', message: `a${i}` })
    rec.stop()
    rec.start()
    rec.handleConsole({ level: 'error', message: 'fresh' })
    expect(events[events.length - 1]).toMatchObject({ type: 'console', message: 'fresh' })
  })
})
