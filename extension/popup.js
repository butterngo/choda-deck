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
  refreshKnowledgePane()
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

// TASK-1456 — knowledgeType picker shows when destination is knowledge (mirrors
// convPane's show/hide pattern). Options are KNOWLEDGE_TYPES from
// src/core/domain/knowledge-types.ts, duplicated here since the extension can't
// import server TS — 'learning' matches the server's DEFAULT_KNOWLEDGE_TYPE.
function refreshKnowledgePane() {
  el('knowledgeTypePane').hidden = el('destination').value !== 'knowledge'
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

// TASK-1452 — the table's Name column shows just the last path segment (DevTools-
// style); the full URL lives in the row's title= tooltip.
function reqName(r) {
  try {
    const u = new URL(r.url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    return (last || u.pathname || u.host) + u.search
  } catch {
    return r.url
  }
}

let capturedRequests = []
// TASK-1373 — filter + multi-select state. Selections are keyed by requestId so
// they survive filter switches; previewId is the last row the user focused.
const FILTERS = ['all', 'api', 'html', 'js', 'css']
let activeFilter = 'all'
const selectedIds = new Set()
let previewId = null
// TASK-1447/1448 — per-group collapse state (keyed by resType) + free-text search,
// both persist across renderReqList() re-renders within the popup session.
const GROUP_ORDER = ['api', 'html', 'js', 'css', 'other']
const collapsedGroups = new Set()
let searchQuery = ''
// TASK-1455 — method + status-class filters, DevTools-Network-tab-style.
let activeMethod = 'all'
let activeStatusClass = 'all'

// TASK-1450 — search matches URL always, and response body text when captured.
function matchesSearch(r) {
  if (!searchQuery) return true
  const q = searchQuery.toLowerCase()
  if ((r.url || '').toLowerCase().includes(q)) return true
  return typeof r.body === 'string' && r.body.toLowerCase().includes(q)
}

// TASK-1455 — status class bucket (2xx/3xx/4xx/5xx); null for uncaptured/invalid status.
function statusClass(status) {
  const n = Number(status)
  if (!Number.isFinite(n) || n < 100 || n > 599) return null
  return `${Math.floor(n / 100)}xx`
}

function filteredRequests() {
  return capturedRequests
    .filter((r) => activeFilter === 'all' || (r.resType || 'api') === activeFilter)
    .filter((r) => activeMethod === 'all' || r.method === activeMethod)
    .filter((r) => activeStatusClass === 'all' || statusClass(r.status) === activeStatusClass)
    .filter(matchesSearch)
}

// Repopulate the method/status <select>s from whatever's currently captured, keeping
// the current selection when it's still a valid option (falls back to "all" otherwise).
function renderNetFilters() {
  const rebuild = (sel, options, current) => {
    sel.innerHTML = ''
    const allOpt = document.createElement('option')
    allOpt.value = 'all'
    allOpt.textContent = sel === el('methodFilter') ? 'All methods' : 'All statuses'
    sel.appendChild(allOpt)
    for (const o of options) {
      const opt = document.createElement('option')
      opt.value = o
      opt.textContent = o
      sel.appendChild(opt)
    }
    sel.value = options.includes(current) ? current : 'all'
    return sel.value
  }
  const methods = [...new Set(capturedRequests.map((r) => r.method))].sort()
  const statuses = ['2xx', '3xx', '4xx', '5xx'].filter((c) =>
    capturedRequests.some((r) => statusClass(r.status) === c)
  )
  activeMethod = rebuild(el('methodFilter'), methods, activeMethod)
  activeStatusClass = rebuild(el('statusFilter'), statuses, activeStatusClass)
}

// Group the filtered rows by resType, in a fixed display order, dropping empty groups.
function groupedRequests() {
  const byGroup = new Map()
  for (const r of filteredRequests()) {
    const g = r.resType || 'api'
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g).push(r)
  }
  const order = [...GROUP_ORDER, ...[...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g))]
  return order.filter((g) => byGroup.has(g)).map((g) => ({ group: g, rows: byGroup.get(g) }))
}

function renderChips() {
  const box = el('typeChips')
  box.innerHTML = ''
  for (const f of FILTERS) {
    const n =
      f === 'all'
        ? capturedRequests.length
        : capturedRequests.filter((r) => (r.resType || 'api') === f).length
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = `${f.toUpperCase()} ${n}`
    b.className = f === activeFilter ? 'active' : ''
    b.addEventListener('click', () => {
      activeFilter = f
      renderChips()
      renderReqList()
    })
    box.appendChild(b)
  }
}

// TASK-1452 — one grid row per request: checkbox / name / method / status / type,
// mirroring Chrome DevTools' Network tab columns instead of a plain checkbox+label list.
function renderReqRow(r) {
  const row = document.createElement('div')
  row.className = 'reqRow' + (r.requestId === previewId ? ' active' : '')
  row.title = r.url
  row.dataset.requestId = r.requestId

  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = selectedIds.has(r.requestId)
  cb.addEventListener('click', (e) => e.stopPropagation())
  cb.addEventListener('change', () => {
    if (cb.checked) selectedIds.add(r.requestId)
    else selectedIds.delete(r.requestId)
    previewId = r.requestId
    syncSelectAll()
    renderReqPreview()
    markActiveRow()
  })

  const name = document.createElement('span')
  name.className = 'reqName'
  name.textContent = reqName(r)

  const method = document.createElement('span')
  method.className = 'reqMethod'
  method.textContent = r.method

  const status = document.createElement('span')
  status.className = 'reqStatus'
  status.textContent = r.status ?? ''

  const type = document.createElement('span')
  type.className = 'reqType'
  type.textContent = (r.resType || 'api').toUpperCase()

  row.append(cb, name, method, status, type)
  row.addEventListener('click', () => {
    previewId = r.requestId
    renderReqPreview()
    markActiveRow()
  })
  return row
}

// Highlights whichever row matches previewId without a full renderReqList() re-render.
function markActiveRow() {
  for (const row of el('reqList').querySelectorAll('.reqRow')) {
    row.classList.toggle('active', row.dataset.requestId === previewId)
  }
}

// TASK-1447 — one collapsible section per resType group; collapse state survives
// re-renders (stored in collapsedGroups, outside this function).
function renderReqList() {
  const list = el('reqList')
  list.innerHTML = ''
  const groups = groupedRequests()
  if (!groups.length) {
    list.textContent = 'no requests seen — reload the page, then reopen'
    el('selectAll').checked = false
    return
  }
  for (const { group, rows } of groups) {
    const section = document.createElement('div')
    section.className = 'reqGroup'

    const collapsed = collapsedGroups.has(group)
    const header = document.createElement('div')
    header.className = 'reqGroupHeader'
    header.textContent = `${collapsed ? '▶' : '▼'} ${group.toUpperCase()} (${rows.length})`
    header.addEventListener('click', () => {
      if (collapsed) collapsedGroups.delete(group)
      else collapsedGroups.add(group)
      renderReqList()
    })
    section.appendChild(header)

    if (!collapsed) {
      for (const r of rows) section.appendChild(renderReqRow(r))
    }
    list.appendChild(section)
  }
  syncSelectAll()
}

// "select all" reflects + toggles exactly the currently filtered set.
function syncSelectAll() {
  const rows = filteredRequests()
  el('selectAll').checked = rows.length > 0 && rows.every((r) => selectedIds.has(r.requestId))
}

function selectedRequests() {
  return capturedRequests.filter((r) => selectedIds.has(r.requestId))
}

// Ask the service worker for the active tab's recent requests (all kinds).
async function loadRequests() {
  try {
    const { requests } = await chrome.runtime.sendMessage({
      type: 'getRequests',
      tabId: activeTab.id
    })
    capturedRequests = requests || []
    renderChips()
    renderNetFilters()
    renderReqList()
    renderReqPreview()
  } catch {
    setStatus('Could not read requests (reload the extension after adding permissions)', 'err')
  }
}

// TASK-1449 — clipboard copy with transient "copied" feedback on the triggering button.
function copyText(text, btn) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const orig = btn.textContent
      btn.textContent = '✓'
      setTimeout(() => {
        btn.textContent = orig
      }, 900)
    })
    .catch(() => {
      btn.textContent = '✗'
    })
}

// TASK-1453 — headers render read-only (copy moved to the hdrPicker dropdown below,
// replacing TASK-1449's per-row copy buttons).
function appendHeaderRows(container, title, headers) {
  const heading = document.createElement('div')
  heading.className = 'hdrTitle'
  heading.textContent = title
  container.appendChild(heading)

  const entries = Object.entries(headers || {})
  if (!entries.length) {
    const none = document.createElement('div')
    none.className = 'hdrRow'
    none.textContent = '(none)'
    container.appendChild(none)
    return
  }
  for (const [k, v] of entries) {
    const row = document.createElement('div')
    row.className = 'hdrRow'
    row.textContent = `${k}: ${v}`
    container.appendChild(row)
  }
}

// TASK-1453 — one <select> covering request + response headers (source-prefixed so
// "content-type" from each side is distinguishable), plus a single Copy button.
function populateHeaderPicker(r) {
  const sel = el('hdrPicker')
  const copyBtn = el('hdrCopyBtn')
  sel.innerHTML = ''

  const entries = r
    ? [
        ...Object.entries(r.requestHeaders || {}).map(([k, v]) => [`req: ${k}`, String(v)]),
        ...Object.entries(r.responseHeaders || {}).map(([k, v]) => [`res: ${k}`, String(v)])
      ]
    : []

  sel.disabled = entries.length === 0
  copyBtn.disabled = entries.length === 0
  for (const [label, value] of entries) {
    const opt = document.createElement('option')
    opt.textContent = label
    opt.value = value
    sel.appendChild(opt)
  }
}

// Show the focused request's method/status + request & response headers (cookie
// and token live in these) right in the popup — inspect without opening DevTools.
function renderReqPreview() {
  const pre = el('reqPreview')
  pre.innerHTML = ''
  const r = capturedRequests.find((x) => x.requestId === previewId)
  if (!r) {
    populateHeaderPicker(null)
    return
  }

  const summary = document.createElement('div')
  summary.className = 'hdrSummary'
  summary.textContent = `${r.method} ${r.url}${r.status ? '  ·  ' + r.status : ''}`
  pre.appendChild(summary)

  appendHeaderRows(pre, 'REQUEST HEADERS', r.requestHeaders)
  appendHeaderRows(pre, 'RESPONSE HEADERS', r.responseHeaders)
  populateHeaderPicker(r)

  // TASK-1450 — copy-response-body button, hidden when the body wasn't captured.
  const bodyTitle = document.createElement('div')
  bodyTitle.className = 'hdrTitle'
  const bodyLabel = document.createElement('span')
  bodyLabel.textContent = 'RESPONSE BODY'
  bodyTitle.appendChild(bodyLabel)
  if (typeof r.body === 'string') {
    const copyBodyBtn = document.createElement('button')
    copyBodyBtn.type = 'button'
    copyBodyBtn.className = 'hdrCopy'
    copyBodyBtn.textContent = '⧉ copy'
    copyBodyBtn.title = 'Copy response body'
    copyBodyBtn.addEventListener('click', () => copyText(r.body, copyBodyBtn))
    bodyTitle.appendChild(copyBodyBtn)
  }
  pre.appendChild(bodyTitle)

  const bodyPre = document.createElement('pre')
  bodyPre.className = 'bodyPre'
  bodyPre.textContent =
    typeof r.body === 'string' ? r.body : '(not captured — reload the page, then retry)'
  pre.appendChild(bodyPre)
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
el('destination').addEventListener('change', () => {
  refreshConvPane()
  refreshKnowledgePane()
})
el('reqSearch').addEventListener('input', () => {
  searchQuery = el('reqSearch').value.trim()
  renderReqList()
})
// TASK-1455 — method/status filters compose with search + type chips via filteredRequests().
el('methodFilter').addEventListener('change', () => {
  activeMethod = el('methodFilter').value
  renderReqList()
})
el('statusFilter').addEventListener('change', () => {
  activeStatusClass = el('statusFilter').value
  renderReqList()
})
// TASK-1454 — re-pull requests in place; search/filter/collapse state (module-level,
// untouched by loadRequests) survives the refresh.
el('reqRefresh').addEventListener('click', async () => {
  const btn = el('reqRefresh')
  const orig = btn.textContent
  btn.disabled = true
  btn.textContent = '⟳ …'
  await loadRequests()
  btn.textContent = orig
  btn.disabled = false
})
// TASK-1453 — copy the header value picked in the dropdown.
el('hdrCopyBtn').addEventListener('click', () => {
  const sel = el('hdrPicker')
  if (sel.disabled || !sel.options.length) return
  copyText(sel.value, el('hdrCopyBtn'))
})
el('selectAll').addEventListener('change', () => {
  const rows = filteredRequests()
  const on = el('selectAll').checked
  for (const r of rows) {
    if (on) selectedIds.add(r.requestId)
    else selectedIds.delete(r.requestId)
  }
  renderReqList()
})
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
  let kind = selectedKind()
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
    const picked = selectedRequests()
    if (!picked.length) return setStatus('Select at least one request first', 'err')
    const toRecord = (r) => ({
      method: r.method,
      url: r.url,
      status: r.status,
      requestHeaders: r.requestHeaders,
      responseHeaders: r.responseHeaders,
      body: r.body
    })
    // One request keeps the original kind:'network' path; 2+ become ONE
    // kind:'network-bundle' → a single .har artifact linked to the entry (TASK-1374).
    if (picked.length === 1) {
      payload = { projectId, record: toRecord(picked[0]) }
    } else {
      kind = 'network-bundle'
      payload = { projectId, entries: picked.map(toRecord) }
    }
  }

  // A — reply into an existing thread when one is picked (any kind can reply).
  if (destination === 'conversation') {
    const convId = el('convTarget').value
    if (convId) payload.conversationId = convId
  }
  // TASK-1456 — dispatcher reads knowledgeType off the payload; 'learning' matches
  // its server-side default, so an untouched picker is still a no-op.
  if (destination === 'knowledge') {
    payload.knowledgeType = el('knowledgeType').value
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
      const extra = kind === 'network-bundle' ? ` (${payload.entries.length} requests → 1 .har)` : ''
      setStatus(`${verb} ${destination} → ${body.id}${extra}`, 'ok')
    } else if (res.status === 401) {
      setStatus('401 — token mismatch. Re-paste it in Options.', 'err')
    } else if (res.status === 413) {
      setStatus('413 — selection too large. Deselect some entries and retry.', 'err')
    } else {
      setStatus(`${res.status} — ${body.error || 'capture failed'}`, 'err')
    }
  } catch {
    setStatus('Bridge not reachable — start companion-server on 127.0.0.1', 'err')
  }
})

init()

// As a side panel this page survives tab switches (a popup never did) — re-bind
// to the newly active tab so requests/selection/preview track it.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  activeTab = await chrome.tabs.get(tabId)
  selectedIds.clear()
  previewId = null
  screenshotDataUrl = null
  searchQuery = ''
  el('reqSearch').value = ''
  if (!el('networkPane').hidden) loadRequests()
})

// ---- Discovery recorder controller (TASK-1414) ------------------------------
// Record ● / Stop ■ toggles the content-script recorder in the active tab, buffers
// its events + snapshots into one session, and POSTs the finalized bundle as
// kind:'discovery-session' at Stop. The raw artifact stays local; only a sanitized
// summary + pointer is synced (the backend dispatcher enforces that).
;(() => {
  let session = null
  let recTabId = null

  const setRec = (text, cls) => {
    const s = el('recStatus')
    s.textContent = text
    s.style.color = cls === 'err' ? '#dc2626' : cls === 'ok' ? '#16a34a' : ''
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!session || !msg) return
    if (msg.type === 'discoveryEvent') {
      session.addEvent(msg.event)
    } else if (msg.type === 'discoverySnapshot') {
      session.addEvent(msg.event)
      session.addSnapshot(msg.snapshot)
    }
    if (session) {
      const c = session.counts()
      setRec(`Recording… ${c.events} events · ${c.snapshots} snapshots`)
    }
  })

  async function start() {
    if (!activeTab) return setRec('No active tab', 'err')
    session = ChodaTimeline.createSession()
    recTabId = activeTab.id
    await chrome.tabs.sendMessage(recTabId, { type: 'discoveryControl', action: 'start' }).catch(() => {})
    el('recBtn').textContent = '■ Stop & save'
    setRec('Recording… 0 events')
  }

  async function stop() {
    const s = session
    session = null
    el('recBtn').textContent = '● Record discovery'
    if (recTabId != null) {
      await chrome.tabs.sendMessage(recTabId, { type: 'discoveryControl', action: 'stop' }).catch(() => {})
    }
    if (!s) return
    const projectId = el('project').value
    if (!projectId) return setRec('Pick a project first', 'err')

    const { bundle, empty, trimmed } = s.finalize({ projectId, label: activeTab && activeTab.title })
    if (empty || !bundle) return setRec('Nothing captured — no session saved.', 'err')

    const { base, token } = await getConfig()
    if (!token) return setRec('No token — paste it in Options', 'err')
    try {
      const res = await fetch(`${base}/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-choda-bridge-token': token },
        body: JSON.stringify({
          kind: 'discovery-session',
          destination: 'inbox',
          payload: bundle,
          sourceUrl: (activeTab && activeTab.url) || bundle.events[0].url || 'about:blank'
        })
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        setRec(`Saved → ${body.id}${trimmed ? ` (trimmed ${trimmed} screenshots to fit)` : ''}`, 'ok')
      } else if (res.status === 413) {
        setRec('413 — session too large even after trimming', 'err')
      } else if (res.status === 401) {
        setRec('401 — token mismatch. Re-paste it in Options.', 'err')
      } else {
        setRec(`${res.status} — ${body.error || 'save failed'}`, 'err')
      }
    } catch {
      setRec('Bridge not reachable — start companion-server on 127.0.0.1', 'err')
    }
  }

  el('recBtn').addEventListener('click', () => (session ? stop() : start()))
})()
