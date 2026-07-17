// TASK-1423 — noise filter for discovery apicall events. Two independent noise
// classes, both measured on the live INBOX-1172 recording (20 apicalls captured,
// ~8 carrying actual behavior):
//
//   1. Telemetry/monitoring — applicationinsights.azure.com/v2/track (x2),
//      js.monitor.azure.com/.../ai.config.json. Never business-relevant. Same
//      class INBOX-1155 flagged from the network-bundle side.
//   2. Asset fan-out — ABookApi/api/Templates/GetEmployeeThumbnail?Id=<N> fired
//      10x, one per avatar. Near-identical calls that bury the distinct data
//      endpoints under repeats of a single behavioral fact.
//
// (1) is a pure URL predicate. (2) is stateful across a recording, so it lives
// behind a per-recording collapser instance rather than a free function.
//
// Dual-mode (no import/export): globalThis for the MV3 classic-script content
// world, module.exports for vitest. Must be listed before recorder.js in the
// manifest's content_scripts js[].

;(function (root) {
  // AC-2 — extend this list to drop a new telemetry vendor. Matched against the
  // full URL, case-insensitively, as plain substrings: these are host/path
  // fragments distinctive enough that a substring hit is not a false positive
  // (an app's own business endpoint does not contain "google-analytics.com").
  // Keep entries vendor-specific; never add a bare word like "api" or "track".
  const DEFAULT_EXCLUDE_PATTERNS = [
    // Azure — the two vendors actually seen in INBOX-1172
    'applicationinsights.azure.com',
    'monitor.azure.com',
    'dc.services.visualstudio.com',
    // Google
    'google-analytics.com',
    'googletagmanager.com',
    'doubleclick.net',
    'analytics.google.com',
    // Common RUM / product analytics / error beacons
    'sentry.io',
    'ingest.sentry.io',
    'datadoghq.com',
    'newrelic.com',
    'nr-data.net',
    'segment.io',
    'segment.com',
    'mixpanel.com',
    'amplitude.com',
    'hotjar.com',
    'fullstory.com',
    'clarity.ms',
    'bat.bing.com',
    'facebook.com/tr'
  ]

  /**
   * True when `url` matches a telemetry/monitoring pattern and should never
   * become an apicall event. Non-string / empty input is NOT noise — it's a
   * malformed record, which handleNetwork rejects on its own terms.
   */
  function isExcluded(url, patterns) {
    if (typeof url !== 'string' || url.length === 0) return false
    const list = patterns || DEFAULT_EXCLUDE_PATTERNS
    const haystack = url.toLowerCase()
    return list.some((p) => haystack.indexOf(p) !== -1)
  }

  /**
   * Collapse key: METHOD + origin + pathname, with the query string dropped.
   * That is what makes ?Id=1 .. ?Id=10 a single key. A URL that won't parse
   * (relative, malformed) degrades to its raw string minus any query — never
   * throws, worst case it just fails to collapse.
   */
  function collapseKey(method, url) {
    const m = String(method || 'GET').toUpperCase()
    try {
      const u = new URL(url)
      return `${m} ${u.origin}${u.pathname}`
    } catch {
      return `${m} ${String(url).split('?')[0]}`
    }
  }

  // How many distinct sample URLs to retain on a collapsed event. The collapse
  // is deliberately lossy about volume but NOT about identity: keeping a few
  // real URLs means a reader can still see it was Id=1,2,3… and not a single
  // call repeated for no reason.
  const MAX_COLLAPSE_SAMPLES = 5

  /**
   * Per-recording collapser. Stateful: it remembers the first event emitted for
   * each key and mutates that event in place as repeats arrive.
   *
   * Why mutate rather than buffer: the recorder emits eagerly into a live
   * timeline buffer, and the total repeat count is unknowable until the
   * recording stops. Holding the first event by reference lets the count settle
   * without delaying emission or reordering the timeline.
   *
   * Returns { admit(event) -> boolean }: true = emit it, false = it was folded
   * into an already-emitted event.
   */
  function createCollapser() {
    const firstByKey = new Map()

    function admit(event) {
      if (!event || event.type !== 'apicall') return true
      const key = collapseKey(event.method, event.url)
      const first = firstByKey.get(key)
      if (!first) {
        firstByKey.set(key, event)
        return true
      }
      first.collapsed = (first.collapsed || 1) + 1
      if (!first.collapsedSamples) first.collapsedSamples = [first.url]
      if (first.collapsedSamples.length < MAX_COLLAPSE_SAMPLES) {
        first.collapsedSamples.push(event.url)
      }
      return false
    }

    function reset() {
      firstByKey.clear()
    }

    return { admit, reset }
  }

  const api = {
    DEFAULT_EXCLUDE_PATTERNS,
    MAX_COLLAPSE_SAMPLES,
    isExcluded,
    collapseKey,
    createCollapser
  }
  root.ChodaNoiseFilter = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
