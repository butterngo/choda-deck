// Choda Capture — page-context interceptor (TASK-1370, MAIN world).
// webRequest gives us headers/cookies/token but never the response body. This runs
// in the PAGE's own context (manifest content_scripts world:"MAIN") and wraps fetch
// + XMLHttpRequest so it can read each response body as the page receives it, then
// posts it to the isolated content script via window.postMessage. Bodies are capped
// so a huge response can't bloat the buffer.

;(() => {
  // TASK-1424 — raised from 20000 so a full API response/request body reaches
  // the recorder without truncating mid-payload; the recorder applies its own
  // (spillable) cap downstream.
  const MAX = 64 * 1024
  const post = (d) => {
    try {
      window.postMessage({ __chodaCapture: true, ...d }, '*')
    } catch {
      /* structured-clone failure — drop */
    }
  }
  const abs = (u) => {
    try {
      return new URL(u, location.href).href
    } catch {
      return u
    }
  }

  // TASK-1424 — only a string request body is captured (the common
  // JSON.stringify(...) case); FormData/Blob/ReadableStream bodies are skipped
  // rather than guessed at.
  const reqBodyOf = (init) => (init && typeof init.body === 'string' ? init.body.slice(0, MAX) : undefined)

  const origFetch = window.fetch
  if (origFetch) {
    window.fetch = function (...args) {
      const reqBody = reqBodyOf(args[1])
      return origFetch.apply(this, args).then((res) => {
        try {
          const url = res.url || abs(typeof args[0] === 'string' ? args[0] : args[0]?.url)
          const method =
            (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET'
          res
            .clone()
            .text()
            .then((t) => post({ url, method, status: res.status, body: t.slice(0, MAX), reqBody }))
            .catch(() => {})
        } catch {
          /* ignore */
        }
        return res
      })
    }
  }

  // TASK-1412 — SPA navigation. history.pushState/replaceState live in the PAGE
  // context, so patch them here (MAIN world) and relay to the isolated recorder.
  const navPost = (url) => {
    try {
      window.postMessage({ __chodaNav: true, url: abs(url), title: document.title }, '*')
    } catch {
      /* ignore */
    }
  }
  for (const name of ['pushState', 'replaceState']) {
    const orig = history[name]
    if (typeof orig === 'function') {
      history[name] = function (state, title, url) {
        const r = orig.apply(this, arguments)
        if (url != null) navPost(url)
        return r
      }
    }
  }
  window.addEventListener('popstate', () => navPost(location.href))

  // TASK-1461 — console capture. Wrap console.error/warn and hook the two global
  // error events, relaying each to the isolated recorder (which caps + redacts
  // before an entry enters a session). Call-through preserves the page's own
  // logging so nothing observes a behavior change.
  const consolePost = (level, message, stack) => {
    try {
      window.postMessage(
        {
          __chodaConsole: true,
          level,
          message: String(message).slice(0, MAX),
          stack: stack ? String(stack).slice(0, MAX) : undefined,
          url: location.href
        },
        '*'
      )
    } catch {
      /* structured-clone failure — drop */
    }
  }
  const fmtArgs = (args) =>
    args
      .map((a) => {
        if (a instanceof Error) return a.message
        if (typeof a === 'string') return a
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')
  for (const level of ['error', 'warn']) {
    const orig = console[level]
    if (typeof orig === 'function') {
      console[level] = function (...args) {
        const err = args.find((a) => a instanceof Error)
        consolePost(level, fmtArgs(args), err && err.stack)
        return orig.apply(this, args)
      }
    }
  }
  window.addEventListener('error', (e) => {
    consolePost('error', e.message || 'uncaught error', e.error && e.error.stack)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    consolePost(
      'error',
      r instanceof Error ? r.message : `unhandled rejection: ${String(r)}`,
      r instanceof Error ? r.stack : undefined
    )
  })

  const origOpen = XMLHttpRequest.prototype.open
  const origSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cc = { method, url: abs(url) }
    return origOpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function (body) {
    const reqBody = typeof body === 'string' ? body.slice(0, MAX) : undefined
    this.addEventListener('load', () => {
      try {
        const resBody = typeof this.responseText === 'string' ? this.responseText : ''
        post({
          url: this.__cc?.url,
          method: this.__cc?.method,
          status: this.status,
          body: resBody.slice(0, MAX),
          reqBody
        })
      } catch {
        /* responseType blob/arraybuffer — no text body */
      }
    })
    return origSend.apply(this, arguments)
  }
})()
