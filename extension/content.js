// Choda Capture — isolated content script (TASK-1370 + TASK-1412).
// Two jobs:
//  1. Relay the MAIN-world interceptor's captured response bodies to the SW
//     (existing network capture — unchanged).
//  2. Discovery recorder (TASK-1412): when recording is on, turn clicks / inputs /
//     SPA navigations into timeline events and forward each to the SW, which the
//     side panel (TASK-1414) buffers into one session.

// ---- 2. discovery recorder (TASK-1412) --------------------------------------
// (declared before the message listener so its handler can reference it)
const recorder = ChodaRecorder.createRecorder({
  emit: (event) => {
    chrome.runtime.sendMessage({ type: 'discoveryEvent', event }).catch(() => {})
  }
})

// ---- 1. network response-body relay (TASK-1370) + nav relay -----------------
window.addEventListener('message', (e) => {
  const d = e.data
  if (e.source !== window || !d) return
  if (d.__chodaCapture === true) {
    chrome.runtime
      .sendMessage({ type: 'responseBody', url: d.url, method: d.method, status: d.status, body: d.body })
      .catch(() => {
        /* SW asleep / popup gone — body simply won't be attached */
      })
  } else if (d.__chodaNav === true) {
    // MAIN-world history patch (inject.js) → recorder nav event.
    recorder.handleNav(d.url, d.title)
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
