// Choda Capture — isolated content script (TASK-1370 + TASK-1412 + network-panel detail tabs).
// Two jobs:
//  1. Relay the MAIN-world interceptor's captured request + response bodies to
//     the SW — neither is visible to chrome.webRequest, so this relay is the
//     only path by which the Network panel's Payload/Response tabs get a body.
//  2. Discovery recorder (TASK-1412): when recording is on, turn clicks / inputs /
//     SPA navigations into timeline events and forward each to the SW, which the
//     side panel (TASK-1414) buffers into one session.

// ---- 2. discovery recorder (TASK-1412) --------------------------------------
// (declared before the message listener so its handler can reference it)
let snapCounter = 0
let snapTimer = null

// TASK-1413 — after a snapshot-worthy event, grab a per-step DOM+CSS snapshot
// (debounced). The SW captures the screenshot (content scripts can't); we
// serialize + redact the DOM here and forward one snapshot record.
function maybeSnapshot(triggerType) {
  if (!ChodaSnapshot.shouldSnapshot(triggerType)) return
  if (snapTimer) clearTimeout(snapTimer)
  snapTimer = setTimeout(() => {
    snapTimer = null
    chrome.runtime.sendMessage({ type: 'captureScreenshot' }, (resp) => {
      void chrome.runtime.lastError // SW asleep → resp undefined; snapshot still useful
      const id = `snap-${++snapCounter}`
      const { snapshot, event } = ChodaSnapshot.takeSnapshot({
        doc: document,
        id,
        screenshotDataUrl: resp && resp.dataUrl ? resp.dataUrl : undefined
      })
      chrome.runtime.sendMessage({ type: 'discoverySnapshot', snapshot, event }).catch(() => {})
    })
  }, 400)
}

const recorder = ChodaRecorder.createRecorder({
  emit: (event) => {
    chrome.runtime.sendMessage({ type: 'discoveryEvent', event }).catch(() => {})
    maybeSnapshot(event.type)
  }
})

// ---- 1. network body relay (TASK-1370/1465) + nav relay ---------------------

// Announce that this tab has a live interceptor. Reloading the extension does NOT
// re-inject content scripts into already-open tabs, so without this the panel can't
// tell "no body captured" from "capture was never running here" — the two look
// identical once webRequest has recorded the headers anyway.
chrome.runtime.sendMessage({ type: 'relayReady' }).catch(() => {})

window.addEventListener('message', (e) => {
  const d = e.data
  if (e.source !== window || !d) return
  if (d.__chodaCapture === true) {
    // reqBody rides along for the panel's Payload tab — webRequest
    // never sees a request body either, only the MAIN-world interceptor does.
    chrome.runtime
      .sendMessage({
        type: 'responseBody',
        url: d.url,
        method: d.method,
        status: d.status,
        body: d.body,
        reqBody: d.reqBody,
        startedAt: d.startedAt
      })
      .catch(() => {
        /* SW asleep / popup gone — body simply won't be attached */
      })
    // TASK-1419 — same interceptor feeds the discovery session as an apicall event
    // (no-op while idle). Keeps the old Network feature's SW relay above unchanged.
    recorder.handleNetwork(d)
  } else if (d.__chodaNav === true) {
    // MAIN-world history patch (inject.js) → recorder nav event.
    recorder.handleNav(d.url, d.title)
  } else if (d.__chodaConsole === true) {
    // TASK-1461 — MAIN-world console/error hooks → recorder console event.
    recorder.handleConsole(d)
  }
})

// Capture-phase listeners at the document root see every event regardless of
// where it lands and before the page can stopPropagation. The recorder no-ops
// while idle, so these are cheap until recording starts.
document.addEventListener('click', (e) => recorder.handleDomEvent(e), true)
document.addEventListener('change', (e) => recorder.handleDomEvent(e), true)
document.addEventListener('input', (e) => recorder.handleDomEvent(e), true)

// Record on/off is driven from the side panel (TASK-1414) via runtime messaging.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'discoveryControl') return
  if (msg.action === 'start') {
    recorder.start()
    // Seed the timeline with the page we started on (a full load has no
    // pushState to hook).
    recorder.handleNav(location.href, document.title)
  } else if (msg.action === 'stop') {
    recorder.stop()
  }
})
