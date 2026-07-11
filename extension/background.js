// Choda Capture — background service worker (TASK-1370).
// Buffers recent API (xmlhttprequest) calls per tab via chrome.webRequest so the
// popup's Network mode can capture one. 'extraHeaders' is required for the Cookie /
// Authorization request headers and Set-Cookie response headers to be visible.
//
// MV3 caveat: response BODIES are NOT available here (needs chrome.debugger). We
// capture method/url/status + request/response headers only — enough to inspect
// the API shape, cookies, and the auth token.

const MAX_PER_TAB = 25
// requestId → record. A plain object; the SW may be torn down when idle, which
// clears the buffer — fine for interactive use (make request → open popup soon).
const requests = {}

function rec(id) {
  if (!requests[id]) requests[id] = { requestId: id }
  return requests[id]
}

// Keep only the newest MAX_PER_TAB records per tab so the buffer can't grow
// unbounded across a long browsing session.
function prune(tabId) {
  const forTab = Object.values(requests)
    .filter((r) => r.tabId === tabId)
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
    r.requestHeaders = toObject(d.requestHeaders)
    prune(d.tabId)
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
  ['requestHeaders', 'extraHeaders']
)

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const r = rec(d.requestId)
    r.status = d.statusCode
    r.responseHeaders = toObject(d.responseHeaders)
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
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
    const list = Object.values(requests)
      .filter((r) => r.tabId === msg.tabId && r.url)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_PER_TAB)
    sendResponse({ requests: list })
  } else if (msg?.type === 'responseBody') {
    attachBody(msg)
  }
  return true
})
