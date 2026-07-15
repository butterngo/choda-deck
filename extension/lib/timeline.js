// TASK-1414 — the session buffer. Collects behavior + snapshot (+ network) events
// while recording, then finalizes them into ONE ts-sorted discovery-session bundle
// at Stop. Two guards live here:
//   - empty-session: Record→Stop with no meaningful interaction → no bundle
//   - size-cap degradation: if the bundle would exceed the 5 MB cap, drop the
//     OLDEST screenshots first (keep behavior/network/html) so the session is
//     never lost to a 413; behavior/network events are never discarded.
// Dual-mode (globalThis + module.exports), no import/export.

;(function (root) {
  const MAX_BUNDLE_BYTES = 5 * 1024 * 1024

  function byteLen(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length
    return Buffer.byteLength(str)
  }

  function createSession() {
    const events = []
    const snapshots = []

    function addEvent(e) {
      if (e && typeof e.type === 'string') events.push(e)
    }
    function addSnapshot(s) {
      if (s && typeof s.id === 'string') snapshots.push(s)
    }
    function counts() {
      return { events: events.length, snapshots: snapshots.length }
    }
    // A lone seed nav (or nothing) is not a session worth keeping.
    function isEmpty() {
      const meaningful = events.filter((e) => e.type !== 'nav').length + snapshots.length
      return events.length === 0 || meaningful === 0
    }

    // opts: { projectId, label?, maxBytes? }
    function finalize(opts) {
      if (isEmpty()) return { bundle: null, empty: true, trimmed: 0, bytes: 0 }
      const maxBytes = opts.maxBytes || MAX_BUNDLE_BYTES
      const sorted = events.slice().sort((a, b) => a.ts - b.ts)
      const snaps = snapshots.map((s) => ({ ...s }))
      const startedAt = sorted[0].ts
      const endedAt = sorted[sorted.length - 1].ts
      const build = () => ({
        projectId: opts.projectId,
        label: opts.label,
        startedAt,
        endedAt,
        events: sorted,
        snapshots: snaps
      })

      let trimmed = 0
      let str = JSON.stringify(build())
      // Drop oldest screenshots first until under the cap. Never touch events.
      while (byteLen(str) > maxBytes) {
        const idx = snaps.findIndex((s) => s.screenshotDataUrl)
        if (idx === -1) break
        delete snaps[idx].screenshotDataUrl
        trimmed++
        str = JSON.stringify(build())
      }
      return { bundle: build(), empty: false, trimmed, bytes: byteLen(str) }
    }

    return { addEvent, addSnapshot, counts, isEmpty, finalize }
  }

  const api = { createSession, MAX_BUNDLE_BYTES }
  root.ChodaTimeline = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
