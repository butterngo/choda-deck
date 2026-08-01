// TASK-1554 — design-token extraction from a rendered page.
//
// Reads getComputedStyle, NOT the authored CSS. extension/lib/snapshot.js:collectCss
// goes through `sheet.cssRules`, which throws a SecurityError on every cross-origin
// stylesheet — and on a real site most CSS arrives from a CDN or a hashed bundle on
// another origin. That path yields only whatever inline <style> blocks happened to be
// same-origin and reports no error, producing a confidently incomplete design.md. Same
// false-confidence class as TASK-1549/1551.
//
// Computed styles are origin-blind: they are the browser's own post-cascade answer, and
// they are what you need to rebuild a look. The trade is real and stated in the output
// (see design-doc.js): this records what the page RENDERED, never what it AUTHORED.
//
// Dual-mode (globalThis + module.exports), no import/export — valid MV3 classic script.

;(function (root) {
  const walkApi = root.ChodaDomWalk || (typeof require !== 'undefined' && require('./dom-walk.js'))

  // Colours closer than this in weighted-RGB space collapse into one swatch. Tuned so
  // #3B82F6 and #3b82f7 merge while blue-500 and blue-600 of a real scale stay apart.
  const COLOR_MERGE_DISTANCE = 12

  // A spacing set counts as a grid only when this share of its values are multiples of
  // the candidate step. Below it, report no grid rather than inventing one (AC-4).
  const GRID_COVERAGE = 0.8
  const GRID_CANDIDATES = [2, 4, 5, 8]

  const NAMED_TRANSPARENT = new Set(['transparent', 'rgba(0, 0, 0, 0)', 'rgba(0,0,0,0)'])

  // ---- colour ---------------------------------------------------------------

  /** Parse rgb()/rgba()/#hex into {r,g,b,a}, or null for anything unparseable. */
  function parseColor(value) {
    if (typeof value !== 'string') return null
    const v = value.trim().toLowerCase()
    if (!v || NAMED_TRANSPARENT.has(v) || v === 'none' || v === 'currentcolor' || v === 'inherit') return null

    const fn = /^rgba?\(([^)]+)\)$/.exec(v)
    if (fn) {
      const parts = fn[1].split(/[\s,/]+/).filter(Boolean)
      if (parts.length < 3) return null
      const [r, g, b] = parts.slice(0, 3).map((n) => (n.endsWith('%') ? Math.round((parseFloat(n) / 100) * 255) : parseInt(n, 10)))
      const a = parts.length > 3 ? parseFloat(parts[3]) : 1
      if ([r, g, b].some((n) => !Number.isFinite(n))) return null
      return { r, g, b, a: Number.isFinite(a) ? a : 1 }
    }

    const hex = /^#([0-9a-f]{3,8})$/.exec(v)
    if (hex) {
      let h = hex[1]
      if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
      if (h.length !== 6 && h.length !== 8) return null
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      }
    }
    return null
  }

  function toHex(c) {
    const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase()
  }

  /**
   * Redmean weighted-RGB distance — a cheap perceptual approximation that beats plain
   * Euclidean without dragging in a Lab conversion. Fully transparent colours never
   * merge with opaque ones: alpha changes what you see, so they are different tokens.
   */
  function colorDistance(a, b) {
    if (!a || !b) return Infinity
    if (Math.abs((a.a ?? 1) - (b.a ?? 1)) > 0.1) return Infinity
    const rm = (a.r + b.r) / 2
    const dr = a.r - b.r
    const dg = a.g - b.g
    const db = a.b - b.b
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)
  }

  /**
   * Frequency-rank colours, merging near-duplicates into the most-used representative.
   * Merging into the MOST FREQUENT member, not the first seen: the dominant shade is
   * the real token and a one-off anti-aliasing variant should not name the swatch.
   */
  function clusterColors(entries, maxDistance) {
    const limit = typeof maxDistance === 'number' ? maxDistance : COLOR_MERGE_DISTANCE
    const sorted = [...entries].sort((a, b) => b.count - a.count)
    const clusters = []
    for (const entry of sorted) {
      const hit = clusters.find((c) => colorDistance(c.color, entry.color) <= limit)
      if (hit) {
        hit.count += entry.count
        hit.merged.push(toHex(entry.color))
        if (!hit.usedOn.includes(entry.usedOn)) hit.usedOn.push(entry.usedOn)
      } else {
        clusters.push({
          color: entry.color,
          hex: toHex(entry.color),
          alpha: entry.color.a ?? 1,
          count: entry.count,
          merged: [],
          usedOn: [entry.usedOn],
          selector: entry.selector
        })
      }
    }
    return clusters.sort((a, b) => b.count - a.count)
  }

  // ---- numeric scales --------------------------------------------------------

  function parsePx(value) {
    if (typeof value !== 'string') return null
    const m = /^(-?[\d.]+)px$/.exec(value.trim())
    if (!m) return null
    const n = parseFloat(m[1])
    return Number.isFinite(n) ? n : null
  }

  /**
   * Detect a base spacing step. Reports null rather than guessing when no candidate
   * covers enough of the observed values — a page on arbitrary spacing has no grid, and
   * claiming 1px (which divides everything) would be true and useless.
   */
  function detectGrid(values, candidates) {
    const positive = values.filter((v) => v > 0)
    if (positive.length < 4) return null
    // A step of 1 divides every integer, so it would "cover" any input and report a
    // 1px grid for a page that has none — true and useless. Steps below 2 are excluded.
    const list = (candidates || GRID_CANDIDATES).filter((s) => s >= 2)
    let best = null
    for (const step of [...list].sort((a, b) => b - a)) {
      const covered = positive.filter((v) => Math.abs(v % step) < 0.01).length
      if (covered / positive.length >= GRID_COVERAGE) {
        best = step
        break
      }
    }
    return best
  }

  function rank(map, limit) {
    return [...map.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
      .slice(0, limit || 24)
  }

  function bump(map, key, by) {
    if (key === undefined || key === null || key === '') return
    map.set(key, (map.get(key) || 0) + (by || 1))
  }

  // ---- collection ------------------------------------------------------------

  const COLOR_PROPS = [
    ['color', 'text'],
    ['backgroundColor', 'background'],
    ['borderTopColor', 'border']
  ]

  const SPACING_PROPS = ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'rowGap', 'columnGap']

  /**
   * Walk the rendered document and accumulate raw token observations.
   *
   * Traversal comes from dom-walk.js with { computed: true } — the same walk
   * readability.js uses, so the two agree on what counts as a visitable element.
   */
  function collectTokens(doc, opts) {
    const options = opts || {}
    const scope = (doc && doc.body) || doc
    const out = {
      colors: [],
      fonts: new Map(),
      spacing: new Map(),
      radii: new Map(),
      shadows: new Map(),
      borders: new Map(),
      zIndex: new Map(),
      elements: 0,
      unreadable: 0
    }
    if (!scope) return out

    const colorAcc = new Map()

    walkApi.walk(
      scope,
      ({ tag, computed }) => {
        if (!computed) return
        out.elements++
        try {
          readInto(out, colorAcc, tag, computed)
        } catch {
          // One element whose computed values cannot be read must not abort the whole
          // extraction — a partial token set beats none. dom-walk already guards the
          // getComputedStyle CALL; this guards the property READS, which can throw
          // separately (happy-dom resolves them lazily through cssRules).
          out.unreadable++
        }
      },
      { computed: true, includeRoot: options.includeRoot !== false, window: options.window }
    )

    out.colors = [...colorAcc.values()]
    return out
  }

  /** Accumulate one element's computed values. Extracted so the caller can guard it. */
  function readInto(out, colorAcc, tag, computed) {
    for (const [prop, role] of COLOR_PROPS) {
      const parsed = parseColor(computed[prop])
      if (!parsed) continue
      // Border colour is reported even when there is no border; skip those or every
      // element contributes its text colour a second time under a border label.
      if (role === 'border' && !parsePx(computed.borderTopWidth)) continue
      const key = `${toHex(parsed)}|${(parsed.a ?? 1).toFixed(2)}|${role}`
      const hit = colorAcc.get(key)
      if (hit) hit.count++
      else colorAcc.set(key, { color: parsed, count: 1, usedOn: role, selector: tag.toLowerCase() })
    }

    const size = parsePx(computed.fontSize)
    if (size) {
      const family = String(computed.fontFamily || '').split(',')[0].replace(/["']/g, '').trim()
      bump(
        out.fonts,
        JSON.stringify({
          family,
          size,
          weight: String(computed.fontWeight || '400'),
          lineHeight: String(computed.lineHeight || 'normal'),
          tag: tag.toLowerCase()
        })
      )
    }

    for (const prop of SPACING_PROPS) {
      const px = parsePx(computed[prop])
      if (px !== null && px !== 0) bump(out.spacing, px)
    }

    const radius = parsePx(computed.borderTopLeftRadius)
    if (radius) bump(out.radii, radius)

    const shadow = String(computed.boxShadow || '').trim()
    if (shadow && shadow !== 'none') bump(out.shadows, shadow)

    const borderWidth = parsePx(computed.borderTopWidth)
    if (borderWidth) bump(out.borders, `${borderWidth}px ${computed.borderTopStyle || 'solid'}`)

    const z = parseInt(computed.zIndex, 10)
    if (Number.isFinite(z)) bump(out.zIndex, z)
  }

  /** Turn raw observations into the ranked, clustered token set design-doc.js renders. */
  function summarize(raw, opts) {
    const options = opts || {}
    const spacingValues = [...raw.spacing.keys()]
    return {
      elements: raw.elements,
      palette: clusterColors(raw.colors, options.colorMergeDistance).slice(0, options.paletteLimit || 12),
      type: rank(raw.fonts, options.typeLimit || 10).map(({ value, count }) => ({ ...JSON.parse(value), count })),
      spacing: { grid: detectGrid(spacingValues, options.gridCandidates), steps: rank(raw.spacing, 16).map((s) => s.value).sort((a, b) => a - b) },
      radii: rank(raw.radii, 8).map((r) => r.value).sort((a, b) => a - b),
      shadows: rank(raw.shadows, 6),
      borders: rank(raw.borders, 6),
      zIndex: rank(raw.zIndex, 8).map((z) => z.value).sort((a, b) => a - b)
    }
  }

  /**
   * Breakpoints, derived by RE-SAMPLING at each width and keeping the ones where the
   * token set actually changes — not by reading @media rules (unreadable cross-origin,
   * the same trap this module exists to avoid) and not by assuming a framework's
   * defaults. `resize` is injected so the caller owns how the viewport is driven.
   */
  function detectBreakpoints(doc, widths, resize) {
    if (typeof resize !== 'function' || !Array.isArray(widths) || !widths.length) return []
    const found = []
    let previous = null
    for (const width of [...widths].sort((a, b) => a - b)) {
      resize(width)
      const fingerprint = fingerprintTokens(summarize(collectTokens(doc)))
      if (previous !== null && fingerprint !== previous) found.push(width)
      previous = fingerprint
    }
    return found
  }

  /** Stable string identity for a token set — two renderings differ iff this differs. */
  function fingerprintTokens(tokens) {
    return JSON.stringify([
      tokens.palette.map((p) => p.hex),
      tokens.type.map((t) => `${t.family}|${t.size}|${t.weight}`),
      tokens.spacing.steps,
      tokens.radii
    ])
  }

  /** Whole-page extraction: collect, summarize, and (optionally) probe breakpoints. */
  function extractDesignTokens(doc, opts) {
    const options = opts || {}
    const tokens = summarize(collectTokens(doc, options), options)
    tokens.breakpoints = options.widths ? detectBreakpoints(doc, options.widths, options.resize) : []
    tokens.url = (doc && doc.location && doc.location.href) || options.url || ''
    tokens.title = (doc && doc.title) || ''
    return tokens
  }

  const api = {
    extractDesignTokens,
    collectTokens,
    summarize,
    clusterColors,
    colorDistance,
    detectGrid,
    detectBreakpoints,
    fingerprintTokens,
    parseColor,
    parsePx,
    toHex,
    COLOR_MERGE_DISTANCE,
    GRID_CANDIDATES,
    GRID_COVERAGE
  }
  root.ChodaDesignTokens = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
