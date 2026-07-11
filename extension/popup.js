// Choda Capture popup — reads config, pulls the current selection / a screenshot,
// and POSTs the capture contract to the local companion bridge (TASK-1330..1332).

const ALL_DESTINATIONS = ['inbox', 'task', 'conversation', 'knowledge']
// image/network kinds are local-only (bridge guards inbox|task → 400).
const LOCAL_ONLY = ['conversation', 'knowledge']

const el = (id) => document.getElementById(id)
const statusEl = el('status')

function setStatus(msg, kind) {
  statusEl.textContent = msg
  statusEl.className = kind || ''
}

async function getConfig() {
  const { base, token } = await chrome.storage.local.get(['base', 'token'])
  return { base: base || 'http://127.0.0.1:7338', token: token || '' }
}

function selectedKind() {
  return document.querySelector('input[name="kind"]:checked').value
}

// Populate the destination dropdown for the active kind (image/network → local-only).
function refreshDestinations() {
  const kind = selectedKind()
  const allowed = kind === 'text' ? ALL_DESTINATIONS : LOCAL_ONLY
  const sel = el('destination')
  const prev = sel.value
  sel.innerHTML = ''
  for (const d of allowed) {
    const opt = document.createElement('option')
    opt.value = d
    opt.textContent = d
    sel.appendChild(opt)
  }
  if (allowed.includes(prev)) sel.value = prev
  el('textPane').hidden = kind !== 'text'
  el('imagePane').hidden = kind !== 'image'
  el('networkPane').hidden = kind !== 'network'
  if (kind === 'network') loadRequests()
  refreshConvPane()
}

// A — reply-to-existing: the conversation picker shows when destination is
// conversation, listing existing threads for the selected project (+ "New").
let allConversations = []

function currentHost() {
  try {
    return new URL(activeTab.url).host
  } catch {
    return ''
  }
}

function refreshConvPane() {
  const show = el('destination').value === 'conversation'
  el('convPane').hidden = !show
  if (show) loadConversations()
}

async function loadConversations() {
  const sel = el('convTarget')
  const projectId = el('project').value
  sel.innerHTML = ''
  const mk = (value, text) => {
    const o = document.createElement('option')
    o.value = value
    o.textContent = text
    sel.appendChild(o)
  }
  mk('', '➕ New conversation')
  try {
    if (!allConversations.length) {
      const { base } = await getConfig()
      const res = await fetch(`${base}/conversations`)
      allConversations = (await res.json()).conversations || []
    }
    allConversations
      .filter((c) => c.projectId === projectId && c.status === 'open')
      .forEach((c) => mk(c.id, `↳ ${c.title || c.id}`))
  } catch {
    /* leave just the New option */
  }
}

// A short label for a request dropdown option — METHOD + path (+ status).
function reqLabel(r) {
  let path = r.url
  try {
    const u = new URL(r.url)
    path = u.host + u.pathname
  } catch { /* keep raw */ }
  if (path.length > 46) path = path.slice(0, 46) + '…'
  return `${r.method} ${path}${r.status ? ' · ' + r.status : ''}`
}

let capturedRequests = []

// Ask the service worker for the active tab's recent API calls.
async function loadRequests() {
  const sel = el('req')
  sel.innerHTML = ''
  try {
    const { requests } = await chrome.runtime.sendMessage({
      type: 'getRequests',
      tabId: activeTab.id
    })
    capturedRequests = requests || []
    if (!capturedRequests.length) {
      const opt = document.createElement('option')
      opt.textContent = 'no requests seen — reload the page, then reopen'
      opt.value = ''
      sel.appendChild(opt)
      return
    }
    capturedRequests.forEach((r, i) => {
      const opt = document.createElement('option')
      opt.value = String(i)
      opt.textContent = reqLabel(r)
      sel.appendChild(opt)
    })
  } catch {
    setStatus('Could not read requests (reload the extension after adding permissions)', 'err')
  }
}

let activeTab = null
let screenshotDataUrl = null

async function init() {
  ;[activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const { base, token } = await getConfig()
  if (!token) {
    setStatus('No token set — open Options and paste data/bridge-token.txt', 'err')
  }

  // Project list from the bridge's read endpoint (no token needed).
  try {
    const res = await fetch(`${base}/projects`)
    const { projects } = await res.json()
    const sel = el('project')
    for (const p of projects) {
      const opt = document.createElement('option')
      opt.value = p.id
      opt.textContent = p.name || p.id
      sel.appendChild(opt)
    }
    if (!projects.length) setStatus('Bridge has no projects', 'err')
    // C — project auto-fit by tab: pre-select the project last used for this host.
    const { projectByDomain = {} } = await chrome.storage.local.get('projectByDomain')
    const remembered = projectByDomain[currentHost()]
    if (remembered && projects.some((p) => p.id === remembered)) sel.value = remembered
  } catch {
    setStatus('Bridge not reachable — is companion-server running on 127.0.0.1?', 'err')
  }

  // Prefill the textarea with the page selection (best-effort; fails on chrome://).
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: () => String(window.getSelection())
    })
    if (result) el('text').value = result
  } catch {
    el('hint').textContent = "(can't read this page — type text or use a screenshot)"
  }

  refreshDestinations()
}

for (const r of document.querySelectorAll('input[name="kind"]')) {
  r.addEventListener('change', refreshDestinations)
}
el('destination').addEventListener('change', refreshConvPane)
// project change re-scopes the conversation reply list to that project
el('project').addEventListener('change', () => {
  if (!el('convPane').hidden) loadConversations()
})

el('grab').addEventListener('click', async () => {
  try {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' })
    el('shot').innerHTML = ''
    const img = document.createElement('img')
    img.src = screenshotDataUrl
    el('shot').appendChild(img)
    setStatus('Screenshot ready', 'ok')
  } catch (e) {
    setStatus(`Screenshot failed: ${e.message}`, 'err')
  }
})

el('send').addEventListener('click', async () => {
  const kind = selectedKind()
  const projectId = el('project').value
  const destination = el('destination').value
  const sourceUrl = activeTab?.url || 'unknown'
  if (!projectId) return setStatus('Pick a project first', 'err')

  let payload
  if (kind === 'text') {
    const text = el('text').value.trim()
    if (!text) return setStatus('Nothing to capture — text is empty', 'err')
    payload = { text, projectId }
  } else if (kind === 'image') {
    if (!screenshotDataUrl) return setStatus('Grab a screenshot first', 'err')
    payload = { dataUrl: screenshotDataUrl, projectId }
  } else {
    const idx = el('req').value
    const r = capturedRequests[Number(idx)]
    if (!r) return setStatus('Pick a request first', 'err')
    payload = {
      projectId,
      record: {
        method: r.method,
        url: r.url,
        status: r.status,
        requestHeaders: r.requestHeaders,
        responseHeaders: r.responseHeaders
      }
    }
  }

  // A — reply into an existing thread when one is picked (any kind can reply).
  if (destination === 'conversation') {
    const convId = el('convTarget').value
    if (convId) payload.conversationId = convId
  }

  const { base, token } = await getConfig()
  setStatus('Sending…')
  try {
    const res = await fetch(`${base}/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-choda-bridge-token': token },
      body: JSON.stringify({ kind, destination, payload, sourceUrl })
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok) {
      // C — remember the project chosen for this host for next time.
      const host = currentHost()
      if (host) {
        const { projectByDomain = {} } = await chrome.storage.local.get('projectByDomain')
        projectByDomain[host] = projectId
        await chrome.storage.local.set({ projectByDomain })
      }
      const verb = payload.conversationId ? 'replied' : '✓'
      setStatus(`${verb} ${destination} → ${body.id}`, 'ok')
    } else if (res.status === 401) {
      setStatus('401 — token mismatch. Re-paste it in Options.', 'err')
    } else {
      setStatus(`${res.status} — ${body.error || 'capture failed'}`, 'err')
    }
  } catch {
    setStatus('Bridge not reachable — start companion-server on 127.0.0.1', 'err')
  }
})

init()
