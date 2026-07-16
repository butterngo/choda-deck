// TASK-1412 — the behavior recorder. Turns raw DOM/nav events into timeline
// events (schema frozen in capture-contract.ts: nav|click|input, each with ts).
// Inert until start(); emits nothing while idle. The content script wires real
// document listeners (capture phase) + SPA history hooks to these handlers; tests
// drive them directly with stub events. Dual-mode, no import/export.
//
// Depends on ChodaRedact (redact.js) + ChodaSelector (selector.js) being loaded
// first — in the manifest content_scripts js[] order, and in tests via require.

;(function (root) {
  const redact = root.ChodaRedact || (typeof require !== 'undefined' && require('./redact.js'))
  const selector = root.ChodaSelector || (typeof require !== 'undefined' && require('./selector.js'))

  // Response bodies are the flow's payload but also the most likely secret carrier —
  // redacted at capture time (like input values) and capped so one big JSON can't
  // bloat the bundle.
  const MAX_API_BODY = 8 * 1024

  // opts: { emit(event), now?(), url?() }
  function createRecorder(opts) {
    const emit = opts.emit
    const now = opts.now || (() => Date.now())
    const currentUrl = opts.url || (() => (typeof location !== 'undefined' ? location.href : undefined))
    let recording = false

    function start() {
      recording = true
    }
    function stop() {
      recording = false
    }
    function isRecording() {
      return recording
    }

    function handleClick(el, text) {
      if (!recording || !el) return
      emit({
        type: 'click',
        ts: now(),
        url: currentUrl(),
        selector: selector.cssPath(el),
        text: typeof text === 'string' ? text.trim().slice(0, 80) : undefined
      })
    }

    function handleInput(el) {
      if (!recording || !el) return
      emit({
        type: 'input',
        ts: now(),
        url: currentUrl(),
        selector: selector.cssPath(el),
        value: redact.redactValue(el)
      })
    }

    // Called by the content script's real listeners.
    function handleDomEvent(domEvent) {
      if (!recording || !domEvent) return
      const el = domEvent.target
      if (domEvent.type === 'click') return handleClick(el, el && el.innerText)
      if (domEvent.type === 'input' || domEvent.type === 'change') return handleInput(el)
    }

    // SPA route change (history.pushState/replaceState/popstate) OR a full nav.
    function handleNav(url, title) {
      if (!recording) return
      emit({ type: 'nav', ts: now(), url: url || currentUrl(), title: title || undefined })
    }

    // TASK-1419 — a fetch/XHR the MAIN-world interceptor (inject.js) relayed:
    // { url, method, status, body }. Turns it into an `apicall` timeline event so
    // the API behind each screen is captured inline. Body redacted + capped.
    function handleNetwork(d) {
      if (!recording || !d || !d.url) return
      emit({
        type: 'apicall',
        ts: now(),
        url: String(d.url),
        method: d.method || 'GET',
        status: typeof d.status === 'number' ? d.status : undefined,
        body: d.body ? redact.redactText(String(d.body)).slice(0, MAX_API_BODY) : undefined
      })
    }

    return { start, stop, isRecording, handleDomEvent, handleClick, handleInput, handleNav, handleNetwork }
  }

  const api = { createRecorder }
  root.ChodaRecorder = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
