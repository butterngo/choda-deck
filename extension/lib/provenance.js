// Choda Capture — deciding which page a network capture came FROM.
//
// The panel used to stamp this as `activeTab.url`, but the side panel persists across
// tab switches while network records come from a per-tab buffer in the service worker.
// Focus and data are therefore independent: capture a localhost row while a timesheet
// tab happens to be focused and the artifact claims the timesheet page made the call.
// A wrong origin does not read as broken — it reads as a fact, so it outlives the
// session and misleads whoever replays the capture later.
//
// Records carry their own `pageUrl` (stamped in background.js from the referer header,
// falling back to the request initiator), so the origin is derived from the DATA and
// `activeTab` is only a fallback for records that carry nothing.
//
// Text and image captures ARE routed through here (resolveTabSource), contrary to what
// this comment said before TASK-1551. The earlier reasoning — "the selected text and the
// grabbed pixels genuinely come from the focused tab, so activeTab.url is already right"
// — was correct about WHICH tab and wrong about WHEN the url was read. The panel binds
// `activeTab` once at init() and re-binds only on tab SWITCH, so after a same-tab
// navigation the binding holds the previous page's url. Same failure as the network
// branch, arriving by a different route.
//
// Dual-mode: assigns to globalThis (classic popup.js load) and module.exports
// (vitest). No import/export keywords — those would break the classic-script load.

;(function (root) {
  // Beyond this many distinct pages we stop listing and say how many are left — a
  // title is a label, not a manifest, and the per-record urls are in the artifact.
  const MAX_LISTED_PAGES = 2

  const UNKNOWN = 'unknown'

  /**
   * Distinct `pageUrl` values across records, in first-seen order. Records missing a
   * pageUrl contribute nothing rather than an empty string — an absent origin must not
   * dilute a present one.
   *
   * @param records array of capture records ({pageUrl})
   * @returns string[]
   */
  function distinctPageUrls(records) {
    const seen = []
    for (const r of records || []) {
      const url = r && typeof r.pageUrl === 'string' ? r.pageUrl.trim() : ''
      if (url && !seen.includes(url)) seen.push(url)
    }
    return seen
  }

  /**
   * Resolve the origin to stamp on a network capture.
   *
   * Precedence is records → activeTab → 'unknown'. The records win because they are
   * the thing being captured; activeTab is a guess that happens to be right only when
   * focus never moved.
   *
   * A selection spanning several pages does not silently collapse to one of them —
   * asserting a single false origin is the exact failure this module exists to stop,
   * so every page is named (up to MAX_LISTED_PAGES, then counted).
   *
   * @param records array of capture records ({pageUrl})
   * @param activeTabUrl url of the tab the panel is bound to, or null/undefined
   * @returns string
   */
  function resolveNetworkSource(records, activeTabUrl) {
    const pages = distinctPageUrls(records)

    if (pages.length === 1) return pages[0]
    if (pages.length > 1) {
      const listed = pages.slice(0, MAX_LISTED_PAGES).join(', ')
      const rest = pages.length - MAX_LISTED_PAGES
      return rest > 0 ? `${listed} (+${rest} more)` : listed
    }

    // No record carried an origin — fall back to focus, and admit ignorance rather
    // than substituting something unrelated.
    const fallback = typeof activeTabUrl === 'string' ? activeTabUrl.trim() : ''
    return fallback || UNKNOWN
  }

  /**
   * Resolve the origin for a recorded discovery session.
   *
   * Recorder events are a mixed bag: `nav` and `click` events carry the page's own
   * location.href, but `apicall` events carry the REQUEST url. So "the first event's
   * url" is only a page url by luck of ordering. The first `nav` event is unambiguous,
   * so prefer it and fall back to focus.
   *
   * @param events array of recorder events ({type, url})
   * @param activeTabUrl url of the tab the panel is bound to, or null/undefined
   * @returns string
   */
  function resolveSessionSource(events, activeTabUrl) {
    for (const e of events || []) {
      if (e && e.type === 'nav' && typeof e.url === 'string' && e.url.trim()) {
        return e.url.trim()
      }
    }
    const fallback = typeof activeTabUrl === 'string' ? activeTabUrl.trim() : ''
    return fallback || UNKNOWN
  }

  /**
   * Resolve the origin for a text or image capture.
   *
   * Two clocks matter here and they are not the same. Pixels are grabbed at one moment
   * and Sent at another, and the user can navigate in between — so the honest origin is
   * the url stamped WHEN THE CONTENT WAS TAKEN (`capturedAtUrl`), not whatever is
   * focused when Send is clicked. `freshTabUrl` is the fallback for content with no
   * capture moment of its own: text typed or pasted straight into the box.
   *
   * Neither input may be the panel's long-lived `activeTab` binding. That is set once at
   * init() and re-bound only when the user switches tabs, so after a same-tab navigation
   * it names the previous page. Offering it as a fallback would turn the common failure
   * into a confident wrong origin instead of an honest missing one — and a wrong origin
   * reads as a fact, survives the session, and misleads whoever replays the capture.
   *
   * @param capturedAtUrl url stamped when the content was captured, or null/undefined
   * @param freshTabUrl url read from the active tab at send time, or null/undefined
   * @returns string
   */
  function resolveTabSource(capturedAtUrl, freshTabUrl) {
    const captured = typeof capturedAtUrl === 'string' ? capturedAtUrl.trim() : ''
    if (captured) return captured
    const fresh = typeof freshTabUrl === 'string' ? freshTabUrl.trim() : ''
    return fresh || UNKNOWN
  }

  const api = {
    resolveNetworkSource,
    resolveSessionSource,
    resolveTabSource,
    distinctPageUrls,
    MAX_LISTED_PAGES,
    UNKNOWN
  }
  root.ChodaProvenance = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
