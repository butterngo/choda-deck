// Choda Capture — isolated content script (TASK-1370). Bridges the MAIN-world
// interceptor (inject.js) to the service worker: it relays captured response
// bodies, which the SW merges into the matching webRequest record by URL.

window.addEventListener('message', (e) => {
  const d = e.data
  if (e.source !== window || !d || d.__chodaCapture !== true) return
  chrome.runtime
    .sendMessage({ type: 'responseBody', url: d.url, method: d.method, status: d.status, body: d.body })
    .catch(() => {
      /* SW asleep / popup gone — body simply won't be attached */
    })
})
