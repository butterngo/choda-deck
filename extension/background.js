// Choda Capture — background service worker (TASK-1370).
// Buffers recent API (xmlhttprequest) calls per tab via chrome.webRequest so the
// popup's Network mode can capture one. 'extraHeaders' is required for the Cookie /
// Authorization request headers and Set-Cookie response headers to be visible.
//
// MV3 caveat: response BODIES are NOT available here (needs chrome.debugger). We
// capture method/url/status + request/response headers only — enough to inspect
// the API shape, cookies, and the auth token.

const MAX_PER_TAB = 25

// TASK-1373 — buffer more than API calls so the popup can filter by kind.
// chrome.webRequest resource type → the popup's filter buckets.
const OBSERVED_TYPES = ['xmlhttprequest', 'main_frame', 'sub_frame', 'script', 'stylesheet']
const RES_TYPE = {
  xmlhttprequest: 'api',
  main_frame: 'html',
  sub_frame: 'html',
  script: 'js',
  stylesheet: 'css'
}
// requestId → record. A plain object; the SW may be torn down when idle, which
// clears the buffer — fine for interactive use (make request → open popup soon).
const requests = {}

function rec(id) {
  if (!requests[id]) requests[id] = { requestId: id }
  return requests[id]
}

// Keep only the newest MAX_PER_TAB records per (tab, resType) so a css/js-heavy
// page can't evict the API calls the user actually wants.
function prune(tabId, resType) {
  const forTab = Object.values(requests)
    .filter((r) => r.tabId === tabId && r.resType === resType)
    .sort((a, b) => b.ts - a.ts)
  for (const r of forTab.slice(MAX_PER_TAB)) delete requests[r.requestId]
}

function toObject(headers) {
  const out = {}
  for (const h of headers || []) out[h.name.toLowerCase()] = h.value
  return out
}

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    const r = rec(d.requestId)
    r.tabId = d.tabId
    r.method = d.method
    r.url = d.url
    r.ts = d.timeStamp
    r.resType = RES_TYPE[d.type] || 'api'
    r.requestHeaders = toObject(d.requestHeaders)
    prune(d.tabId, r.resType)
  },
  { urls: ['<all_urls>'], types: OBSERVED_TYPES },
  ['requestHeaders', 'extraHeaders']
)

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const r = rec(d.requestId)
    r.status = d.statusCode
    r.responseHeaders = toObject(d.responseHeaders)
  },
  { urls: ['<all_urls>'], types: OBSERVED_TYPES },
  ['responseHeaders', 'extraHeaders']
)

// Response bodies arrive from the page interceptor (content.js). webRequest never
// sees a body, so merge it onto the most recent same-URL record that lacks one.
function attachBody(msg) {
  const rec = Object.values(requests)
    .filter((r) => r.url === msg.url && (!msg.method || r.method === msg.method) && r.body === undefined)
    .sort((a, b) => b.ts - a.ts)[0]
  if (rec) rec.body = msg.body
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getRequests') {
    // All buffered kinds for the tab; the popup filters by resType client-side.
    const list = Object.values(requests)
      .filter((r) => r.tabId === msg.tabId && r.url)
      .sort((a, b) => b.ts - a.ts)
    console.log('[choda-capture] getRequests', msg.tabId, list.length, 'records')
    sendResponse({ requests: list })
  } else if (msg?.type === 'responseBody') {
    attachBody(msg)
  }
  return true
})
