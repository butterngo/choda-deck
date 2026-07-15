// Choda Capture — page-context interceptor (TASK-1370, MAIN world).
// webRequest gives us headers/cookies/token but never the response body. This runs
// in the PAGE's own context (manifest content_scripts world:"MAIN") and wraps fetch
// + XMLHttpRequest so it can read each response body as the page receives it, then
// posts it to the isolated content script via window.postMessage. Bodies are capped
// so a huge response can't bloat the buffer.

;(() => {
  const MAX = 20000
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

  const origFetch = window.fetch
  if (origFetch) {
    window.fetch = function (...args) {
      return origFetch.apply(this, args).then((res) => {
        try {
          const url = res.url || abs(typeof args[0] === 'string' ? args[0] : args[0]?.url)
          const method =
            (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET'
          res
            .clone()
            .text()
            .then((t) => post({ url, method, status: res.status, body: t.slice(0, MAX) }))
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

  const origOpen = XMLHttpRequest.prototype.open
  const origSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cc = { method, url: abs(url) }
    return origOpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        const body = typeof this.responseText === 'string' ? this.responseText : ''
        post({ url: this.__cc?.url, method: this.__cc?.method, status: this.status, body: body.slice(0, MAX) })
      } catch {
        /* responseType blob/arraybuffer — no text body */
      }
    })
    return origSend.apply(this, arguments)
  }
})()
