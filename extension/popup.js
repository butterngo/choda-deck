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
// Whether the SW has heard from an interceptor in this tab. Drives the
// wording of the empty-body hint: "reload the page" is only useful advice when
// capture genuinely isn't running there.
let tabInstrumented = true

// The four live filters as one object, for lib/reqfilter.js (which owns the
// predicates so they're testable — the chip-count bug lived in this logic).
function filterState() {
  return {
    type: activeFilter,
    method: activeMethod,
    statusClass: activeStatusClass,
    query: searchQuery
  }
}

function statusClass(status) {
  return ChodaReqFilter.statusClass(status)
}

function filteredRequests() {
  const f = filterState()
  return capturedRequests.filter((r) => ChodaReqFilter.matches(r, f))
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
  const state = filterState()
  for (const f of FILTERS) {
    const n = ChodaReqFilter.countForType(capturedRequests, f, state)
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
    // Distinguish "nothing captured" from "filters hid everything" — the old wording
    // told you to reload the page even when the page had plenty and a filter was on.
    list.textContent = capturedRequests.length
      ? 'no requests match the current filters'
      : 'no requests seen — reload the page, then reopen'
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
    const { requests, instrumented } = await chrome.runtime.sendMessage({
      type: 'getRequests',
      tabId: activeTab.id
    })
    capturedRequests = requests || []
    tabInstrumented = instrumented !== false
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

// Detail pane mirrors DevTools' Network tabs. Initiator and Timing
// are deliberately absent: webRequest exposes neither a request-initiator stack
// nor per-phase timings, so those tabs could only ever render empty.
// Shown instead of "nothing captured" when the SW has never heard from an
// interceptor in this tab — the tab predates the last extension reload, so no
// amount of retrying in the panel will produce a body.
const NOT_INSTRUMENTED_HINT =
  '(capture not active in this tab — reload the PAGE, then ⟳ Refresh)'

const DETAIL_TABS = ['headers', 'payload', 'preview', 'response', 'cookies']
let activeDetailTab = 'headers'
// Per-section collapse + raw-view state, keyed by section id. Both persist across
// re-renders and across row switches — inspecting five requests in a row
// shouldn't mean re-collapsing General five times.
const collapsedSections = new Set()
const rawSections = new Set()

// Two-column name/value grid, DevTools-style — the value column wraps, the name
// column doesn't, so long tokens don't push the names out of alignment.
function appendKV(container, rows, emptyText) {
  if (!rows.length) {
    const none = document.createElement('div')
    none.className = 'kvEmpty'
    none.textContent = emptyText
    container.appendChild(none)
    return
  }
  for (const [k, v] of rows) {
    const row = document.createElement('div')
    row.className = 'kvRow'
    const name = document.createElement('span')
    name.className = 'kvName'
    name.textContent = k
    const value = document.createElement('span')
    value.className = 'kvValue'
    value.textContent = v
    row.append(name, value)
    container.appendChild(row)
  }
}

// A collapsible ▾/▸ section. `rawText` non-null adds the Raw checkbox, which
// swaps the parsed rows for the wire-format text (DevTools' behavior).
function appendSection(container, id, title, rows, { rawText = null, emptyText = '(none)' } = {}) {
  const section = document.createElement('div')
  section.className = 'detailSection'

  const head = document.createElement('div')
  head.className = 'sectionHead'
  const collapsed = collapsedSections.has(id)

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'sectionToggle'
  toggle.textContent = `${collapsed ? '▸' : '▾'} ${title}`
  toggle.addEventListener('click', () => {
    if (collapsed) collapsedSections.delete(id)
    else collapsedSections.add(id)
    renderReqPreview()
  })
  head.appendChild(toggle)

  if (rawText !== null) {
    const label = document.createElement('label')
    label.className = 'rawToggle'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = rawSections.has(id)
    cb.addEventListener('change', () => {
      if (cb.checked) rawSections.add(id)
      else rawSections.delete(id)
      renderReqPreview()
    })
    label.append(cb, document.createTextNode('Raw'))
    head.appendChild(label)
  }
  section.appendChild(head)

  if (!collapsed) {
    if (rawText !== null && rawSections.has(id)) {
      const pre = document.createElement('pre')
      pre.className = 'bodyPre'
      pre.textContent = rawText || emptyText
      section.appendChild(pre)
    } else {
      appendKV(section, rows, emptyText)
    }
  }
  container.appendChild(section)
}

// One right-aligned action row per tab. Each entry is [label, title, text|null] —
// a null text disables the button (nothing captured to copy).
function appendActions(container, actions) {
  const row = document.createElement('div')
  row.className = 'detailActions'
  for (const [label, title, text] of actions) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'hdrCopy'
    btn.textContent = label
    btn.title = title
    btn.disabled = typeof text !== 'string' || text === ''
    if (!btn.disabled) btn.addEventListener('click', () => copyText(text, btn))
    row.appendChild(btn)
  }
  container.appendChild(row)
}

// Tab strip + the ✕ that closes the detail pane (clears the focused row).
function renderDetailTabs(hasRequest) {
  const bar = el('reqTabs')
  bar.hidden = !hasRequest
  bar.innerHTML = ''
  if (!hasRequest) return

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'tabClose'
  close.textContent = '✕'
  close.title = 'Close detail pane'
  close.addEventListener('click', () => {
    previewId = null
    renderReqPreview()
    markActiveRow()
  })
  bar.appendChild(close)

  for (const t of DETAIL_TABS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = t[0].toUpperCase() + t.slice(1)
    b.className = t === activeDetailTab ? 'active' : ''
    b.addEventListener('click', () => {
      activeDetailTab = t
      renderReqPreview()
    })
    bar.appendChild(b)
  }
}

// Headers — General block, then response + request headers, each collapsible with
// its own Raw toggle. Copy-as-cURL lives here (DevTools hides it in a context menu
// on the row; a visible button costs nothing and is what this pane is for).
function renderHeadersTab(pre, r) {
  appendActions(pre, [
    ['⧉ copy as cURL', 'Copy this request as a curl command', ChodaCurl.buildCurl(r)],
    ['⧉ copy url', 'Copy the request URL', r.url]
  ])
  appendSection(pre, 'general', 'General', ChodaNetView.generalRows(r))
  appendSection(
    pre,
    'resHeaders',
    'Response headers',
    Object.entries(r.responseHeaders || {}),
    { rawText: ChodaNetView.rawHeaderText(r.responseHeaders) }
  )
  appendSection(
    pre,
    'reqHeaders',
    'Request headers',
    Object.entries(r.requestHeaders || {}),
    { rawText: ChodaNetView.rawHeaderText(r.requestHeaders) }
  )
}

// Body panes: Preview pretty-prints JSON, Response shows the bytes as received.
// Splitting them is the whole point of DevTools having both tabs — a raw view is
// what you paste elsewhere, a parsed view is what you read.
function renderBodyTab(pre, text, { pretty, missingHint, copyLabel }) {
  const shown = typeof text === 'string' ? (pretty ? ChodaCurl.prettyJson(text) : text) : null
  appendActions(pre, [[copyLabel, 'Copy what this tab shows', shown]])
  const body = document.createElement('pre')
  body.className = 'bodyPre'
  body.textContent = shown === null ? missingHint : shown
  pre.appendChild(body)
}

// Cookies — request-side Cookie pairs and response-side Set-Cookie, parsed out of
// the headers (webRequest needs 'extraHeaders' to expose either, which background.js
// already requests).
function renderCookiesTab(pre, r) {
  const reqCookies = ChodaNetView.parseRequestCookies(r.requestHeaders)
  const resCookies = ChodaNetView.parseResponseCookies(r.responseHeaders)
  appendSection(
    pre,
    'resCookies',
    'Response cookies',
    resCookies.map((c) => [c.name, [c.value, ...c.attributes].join('; ')]),
    { emptyText: '(no Set-Cookie on this response)' }
  )
  appendSection(
    pre,
    'reqCookies',
    'Request cookies',
    reqCookies.map((c) => [c.name, c.value]),
    { emptyText: '(no Cookie header sent)' }
  )
}

// Show the focused request in the active tab, so the common inspection jobs never
// need DevTools open alongside the panel.
function renderReqPreview() {
  const pre = el('reqPreview')
  pre.innerHTML = ''
  const r = capturedRequests.find((x) => x.requestId === previewId)
  renderDetailTabs(Boolean(r))
  if (!r) return

  const summary = document.createElement('div')
  summary.className = 'hdrSummary'
  summary.textContent = `${r.method} ${r.url}${r.status ? '  ·  ' + r.status : ''}`
  pre.appendChild(summary)

  if (activeDetailTab === 'headers') return renderHeadersTab(pre, r)
  if (activeDetailTab === 'cookies') return renderCookiesTab(pre, r)

  // Payload — only string request bodies survive inject.js's interceptor, so
  // FormData / Blob / URLSearchParams posts legitimately land here empty.
  if (activeDetailTab === 'payload') {
    return renderBodyTab(pre, r.reqBody, {
      pretty: true,
      missingHint: tabInstrumented
        ? '(no request body captured — GET, or a non-text body)'
        : NOT_INSTRUMENTED_HINT,
      copyLabel: '⧉ copy payload'
    })
  }

  return renderBodyTab(pre, r.body, {
    pretty: activeDetailTab === 'preview',
    missingHint: tabInstrumented
      ? '(no body captured — a non-text response, or one the page never read)'
      : NOT_INSTRUMENTED_HINT,
    copyLabel: '⧉ copy body'
  })
}

let activeTab = null
// TASK-1458 — the source Image backing the canvas, kept around so "Clear markup"
// can redraw the unmarked capture instead of undoing individual strokes.
let shotImg = null

// TASK-1457/1458 — loads a data URL (from Grab or paste) onto the canvas at its
// natural resolution; CSS scales it down for display, drawing math below un-scales
// pointer coordinates back to canvas pixel space.
function setScreenshot(dataUrl) {
  const img = new Image()
  img.onload = () => {
    shotImg = img
    const canvas = el('shotCanvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.hidden = false
    canvas.getContext('2d').drawImage(img, 0, 0)
    el('shotClear').hidden = false
    el('shotRemove').hidden = false
  }
  img.src = dataUrl
}

function clearShotMarkup() {
  if (!shotImg) return
  const canvas = el('shotCanvas')
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(shotImg, 0, 0)
}

// TASK-1459 — discard the image entirely (not just its markup) so Grab/paste can
// load a fresh one into a clean panel; same end state as the tab-switch reset below.
function removeShot() {
  shotImg = null
  const canvas = el('shotCanvas')
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
  canvas.hidden = true
  el('shotClear').hidden = true
  el('shotRemove').hidden = true
  setStatus('Image removed', 'ok')
}

// TASK-1458 — freehand highlighter: drag on the canvas to paint a translucent stroke.
;(() => {
  let drawing = false
  let last = null

  const point = (e) => {
    const canvas = el('shotCanvas')
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height
    }
  }

  el('shotCanvas').addEventListener('mousedown', (e) => {
    drawing = true
    last = point(e)
  })
  el('shotCanvas').addEventListener('mousemove', (e) => {
    if (!drawing) return
    const p = point(e)
    const ctx = el('shotCanvas').getContext('2d')
    ctx.strokeStyle = 'rgba(255, 224, 32, 0.55)'
    ctx.lineWidth = 18
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(last.x, last.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last = p
  })
  window.addEventListener('mouseup', () => {
    drawing = false
  })
})()

el('shotClear').addEventListener('click', clearShotMarkup)
el('shotRemove').addEventListener('click', removeShot)

// TASK-1457 — Ctrl+V an image (Snipping Tool, copied from a webpage, …) straight
// into Screenshot mode; non-image clipboard content is ignored, no error shown.
document.addEventListener('paste', (e) => {
  if (selectedKind() !== 'image') return
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))
  const file = item?.getAsFile()
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    setScreenshot(reader.result)
    setStatus('Pasted image ready', 'ok')
  }
  reader.readAsDataURL(file)
})

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
// Each of these re-renders the chips too: their badges now count post-filter, so a
// stale chip would contradict the list right below it.
el('reqSearch').addEventListener('input', () => {
  searchQuery = el('reqSearch').value.trim()
  renderChips()
  renderReqList()
})
// TASK-1455 — method/status filters compose with search + type chips via filteredRequests().
el('methodFilter').addEventListener('change', () => {
  activeMethod = el('methodFilter').value
  renderChips()
  renderReqList()
})
el('statusFilter').addEventListener('change', () => {
  activeStatusClass = el('statusFilter').value
  renderChips()
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
    const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' })
    setScreenshot(dataUrl)
    setStatus('Screenshot ready', 'ok')
  } catch (e) {
    setStatus(`Screenshot failed: ${e.message}`, 'err')
  }
})

// TASK-1462 — extract the whole readable page (title + body innerText, script/style
// noise excluded by innerText) into the textarea, capped so it can't overflow the
// text capture's 64 KB limit. Parity with claude-in-chrome's get_page_text.
const PAGE_TEXT_CAP = 60 * 1024
el('grabText').addEventListener('click', async () => {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: () => {
        const title = document.title ? `# ${document.title}\n\n` : ''
        const body = (document.body && document.body.innerText) || ''
        return title + body
      }
    })
    let text = result || ''
    if (text.length > PAGE_TEXT_CAP) {
      text = text.slice(0, PAGE_TEXT_CAP) + `\n\n…(truncated at ${PAGE_TEXT_CAP} chars)`
    }
    el('text').value = text
    setStatus(text.trim() ? 'Page text grabbed' : 'Page had no readable text', text.trim() ? 'ok' : 'err')
  } catch {
    setStatus("Can't read this page (chrome:// or restricted) — select text manually", 'err')
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
    // TASK-1458 — read the canvas's live pixels so any highlighter markup is baked in.
    const canvas = el('shotCanvas')
    if (canvas.hidden) return setStatus('Grab a screenshot first', 'err')
    payload = { dataUrl: canvas.toDataURL('image/png'), projectId }
  } else {
    const picked = selectedRequests()
    if (!picked.length) return setStatus('Select at least one request first', 'err')
    const toRecord = (r) => ({
      method: r.method,
      url: r.url,
      status: r.status,
      requestHeaders: r.requestHeaders,
      responseHeaders: r.responseHeaders,
      body: r.body,
      reqBody: r.reqBody
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
  shotImg = null
  el('shotCanvas').hidden = true
  el('shotClear').hidden = true
  el('shotRemove').hidden = true
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
