// Choda Capture — background service worker (TASK-1370).
// Buffers recent API (xmlhttprequest) calls per tab via chrome.webRequest so the
// popup's Network mode can capture one. 'extraHeaders' is required for the Cookie /
// Authorization request headers and Set-Cookie response headers to be visible.
//
// MV3 caveat: response BODIES are NOT available here (needs chrome.debugger). We
// capture method/url/status + request/response headers only — enough to inspect
// the API shape, cookies, and the auth token.

// Toolbar click opens the full-height side panel (popup.html serves as the
// panel page) — popups are hard-capped at 800x600, the side panel is not.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

// Classic-script SW, so the shared correlation helper loads via importScripts.
importScripts('lib/correlate.js')

const MAX_PER_TAB = 25

// Tabs whose content script has announced itself (or relayed a body) since this SW
// started. Absence is a soft signal — a SW restart clears it — so the panel words
// its hint as a suggestion, never as a definitive "capture is off".
const instrumentedTabs = new Set()

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
    // Which PAGE made this call, stamped now rather than read off the focused tab at
    // capture time — the panel outlives tab switches, so focus is not provenance.
    // referer carries the full url incl. path; d.initiator is origin-only but always
    // present for page-initiated requests. Deliberately not chrome.tabs.get(tabId):
    // that reports where the tab is NOW, so an SPA that has since navigated would
    // hand back a confidently wrong page.
    r.pageUrl = r.requestHeaders.referer || d.initiator || undefined
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

// Bodies arrive from the page interceptor (content.js) — webRequest sees neither
// the request nor the response body. Correlation is delegated to lib/correlate.js:
// matching on (url, method) alone mis-routes bodies when a page fires the same
// request concurrently, which is ordinary behavior, so the page's call-time stamp
// breaks the tie — see the network-panel body-correlation learning entry.
function attachBody(msg) {
  const rec = ChodaCorrelate.pickRecordForBody(Object.values(requests), msg)
  if (!rec) return
  rec.body = msg.body
  if (typeof msg.reqBody === 'string') rec.reqBody = msg.reqBody
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'getRequests') {
    // All buffered kinds for the tab; the popup filters by resType client-side.
    const list = Object.values(requests)
      .filter((r) => r.tabId === msg.tabId && r.url)
      .sort((a, b) => b.ts - a.ts)
    console.log('[choda-capture] getRequests', msg.tabId, list.length, 'records')
    sendResponse({ requests: list, instrumented: instrumentedTabs.has(msg.tabId) })
  } else if (msg?.type === 'relayReady') {
    if (sender.tab) instrumentedTabs.add(sender.tab.id)
  } else if (msg?.type === 'responseBody') {
    // A relayed body is itself proof the interceptor is live in that tab, which
    // re-establishes the flag after a SW restart drops it.
    if (sender.tab) instrumentedTabs.add(sender.tab.id)
    attachBody(msg)
  } else if (msg?.type === 'captureScreenshot') {
    // TASK-1413 — content scripts can't call captureVisibleTab; the SW does it and
    // returns a small JPEG (q60) so the screenshot never dominates the 5 MB bundle.
    chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 60 }, (dataUrl) => {
      sendResponse({ dataUrl: chrome.runtime.lastError ? null : dataUrl })
    })
    return true // async sendResponse
  }
  return true
})
