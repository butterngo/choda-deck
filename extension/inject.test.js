// End-to-end test of the body pipeline: the MAIN-world interceptor (inject.js)
// → the message it posts → the SW's correlation (lib/correlate.js) → the record
// the Network panel finally reads. Unit-testing either half alone misses exactly
// the bug this pipeline had, which lived in the seam between them.

const { pickRecordForBody } = require('./lib/correlate.js')

// --- fake page context, installed before inject.js's IIFE runs ----------------
const posted = []
let clock = 1_000_000

const listeners = {}
global.window = {
  postMessage: (m) => posted.push(m),
  addEventListener: (type, fn) => {
    listeners[type] = fn
  }
}
global.document = { title: 'test page' }
global.location = { href: 'https://app.test/admin/projects' }
global.history = { pushState() {}, replaceState() {} }
global.XMLHttpRequest = function XHR() {}
global.XMLHttpRequest.prototype.open = function () {}
global.XMLHttpRequest.prototype.send = function () {}

// Deferred fetch: each call parks until the test resolves it, so responses can be
// completed out of order — the scenario that broke correlation in the real panel.
const pending = []
window.fetch = (url, init) => {
  const d = {}
  d.promise = new Promise((resolve) => {
    d.resolve = resolve
  })
  pending.push(d)
  d.url = typeof url === 'string' ? url : url.url
  d.init = init
  return d.promise
}

const realNow = Date.now
Date.now = () => clock

require('./inject.js')

afterAll(() => {
  Date.now = realNow
})

// Complete the Nth outstanding fetch with a JSON body, then let the interceptor's
// .clone().text().then(...) microtasks flush.
async function completeFetch(index, body, status = 200) {
  const d = pending[index]
  const res = {
    url: d.url,
    status,
    clone: () => ({ text: () => Promise.resolve(body) })
  }
  d.resolve(res)
  await new Promise((r) => setImmediate(r))
}

const URL_A = 'https://app.test/api/admin/projects?page=1&pageSize=10'

describe('inject.js → posted message', () => {
  beforeEach(() => {
    posted.length = 0
    pending.length = 0
  })

  it('posts the response body, url, method, status and a call-time stamp', async () => {
    clock = 1_000_000
    window.fetch(URL_A)
    await completeFetch(0, '{"success":true}')

    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      __chodaCapture: true,
      url: URL_A,
      method: 'GET',
      status: 200,
      body: '{"success":true}',
      startedAt: 1_000_000
    })
  })

  it('posts the request body for a POST with a string payload', async () => {
    clock = 1_000_000
    window.fetch(URL_A, { method: 'POST', body: '{"name":"a"}' })
    await completeFetch(0, '{"id":1}')

    expect(posted[0]).toMatchObject({
      method: 'POST',
      reqBody: '{"name":"a"}',
      body: '{"id":1}'
    })
  })

  it('omits reqBody for a non-string payload rather than guessing at it', async () => {
    clock = 1_000_000
    window.fetch(URL_A, { method: 'POST', body: { not: 'a string' } })
    await completeFetch(0, '{}')

    expect(posted[0].reqBody).toBeUndefined()
  })
})

// The regression that made Preview read "(not captured)" on a page that fetches
// the same endpoint three times.
describe('pipeline — three identical requests completing out of order', () => {
  it('lands each response body on the record for the call that made it', async () => {
    posted.length = 0
    pending.length = 0

    // Three calls to the same endpoint, 10ms apart on the page clock.
    clock = 1_000_000
    window.fetch(URL_A)
    clock = 1_000_010
    window.fetch(URL_A)
    clock = 1_000_020
    window.fetch(URL_A)

    // webRequest recorded all three at (near) the same instants.
    const records = [
      { requestId: 'a', url: URL_A, method: 'GET', ts: 1_000_001 },
      { requestId: 'b', url: URL_A, method: 'GET', ts: 1_000_011 },
      { requestId: 'c', url: URL_A, method: 'GET', ts: 1_000_021 }
    ]

    // Completion order deliberately scrambled: 2nd, then 3rd, then 1st.
    await completeFetch(1, '"body-B"')
    await completeFetch(2, '"body-C"')
    await completeFetch(0, '"body-A"')

    for (const msg of posted) {
      const rec = pickRecordForBody(records, msg)
      expect(rec).not.toBeNull()
      rec.body = msg.body
    }

    expect(records.find((r) => r.requestId === 'a').body).toBe('"body-A"')
    expect(records.find((r) => r.requestId === 'b').body).toBe('"body-B"')
    expect(records.find((r) => r.requestId === 'c').body).toBe('"body-C"')
  })

  it('leaves no record empty even when start times are indistinguishable', async () => {
    posted.length = 0
    pending.length = 0

    // Same millisecond for all three — pairing is then ambiguous by construction
    // (there is no shared id between the two sides), but nothing may be dropped.
    clock = 2_000_000
    window.fetch(URL_A)
    window.fetch(URL_A)
    window.fetch(URL_A)

    const records = [
      { requestId: 'a', url: URL_A, method: 'GET', ts: 2_000_000 },
      { requestId: 'b', url: URL_A, method: 'GET', ts: 2_000_000 },
      { requestId: 'c', url: URL_A, method: 'GET', ts: 2_000_000 }
    ]

    await completeFetch(2, '"x"')
    await completeFetch(0, '"y"')
    await completeFetch(1, '"z"')

    for (const msg of posted) {
      const rec = pickRecordForBody(records, msg)
      expect(rec).not.toBeNull()
      rec.body = msg.body
    }

    expect(records.every((r) => typeof r.body === 'string')).toBe(true)
    expect(records.map((r) => r.body).sort()).toEqual(['"x"', '"y"', '"z"'])
  })
})
