// TASK-1554 — render a token set (design-tokens.js) as design.md.
//
// The limits section is not boilerplate and is not optional. Computed-style extraction
// cannot see authored variable names, unrendered pseudo-states, or a dark mode that was
// not active — and a design.md that silently omits hover states invites the reader to
// assume there are none. Stating the blind spots inside the document is the difference
// between a useful artifact and a confidently incomplete one (TASK-1549/1551).
//
// Dual-mode (globalThis + module.exports), no import/export — valid MV3 classic script.

;(function (root) {
  const LIMITS = [
    'Authored CSS variable names (`--brand-500`) — computed styles resolve variables away, so the values are here but their names are not.',
    'Unrendered pseudo-states: `:hover`, `:focus`, `:active`, `:disabled`, and validation/error styling. **The absence of hover styling below is not evidence the site has none.**',
    'Dark mode, unless it was the active theme when this ran.',
    'Anything behind an interaction — modal, dropdown, tooltip, or tab panel that was closed at capture time.',
    'Cross-origin `@font-face` sources. Family names are reported as the browser resolved them; the font files are not.',
    'Authored source structure — which rules came from which stylesheet, and which were unused.'
  ]

  function fmtPx(n) {
    return `${Number.isInteger(n) ? n : Math.round(n * 100) / 100}px`
  }

  function table(headers, rows) {
    if (!rows.length) return '_none observed_'
    return [
      `| ${headers.join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`,
      ...rows.map((r) => `| ${r.join(' | ')} |`)
    ].join('\n')
  }

  function paletteSection(palette) {
    const rows = palette.map((p) => [
      p.alpha < 1 ? `${p.hex} @ ${Math.round(p.alpha * 100)}%` : p.hex,
      String(p.count),
      p.usedOn.join(', '),
      p.merged.length ? `merged ${p.merged.length}` : ''
    ])
    return table(['Value', 'Uses', 'Role', 'Notes'], rows)
  }

  function typeSection(type) {
    const rows = type.map((t) => [
      t.tag,
      t.family || '_inherit_',
      fmtPx(t.size),
      t.weight,
      t.lineHeight === 'normal' ? 'normal' : t.lineHeight,
      String(t.count)
    ])
    return table(['Tag', 'Family', 'Size', 'Weight', 'Line height', 'Uses'], rows)
  }

  function spacingSection(spacing) {
    const steps = spacing.steps.length ? spacing.steps.map(fmtPx).join(' · ') : '_none observed_'
    // "No grid detected" is a real finding, not a failure — a page on arbitrary spacing
    // has none, and naming a step that merely divides everything would be useless.
    const grid = spacing.grid
      ? `Base grid: **${fmtPx(spacing.grid)}**`
      : 'Base grid: **none detected** — observed values do not sit on a consistent step.'
    return `${grid}\n\nObserved steps: ${steps}`
  }

  function listOrNone(values, fmt) {
    if (!values || !values.length) return '_none observed_'
    return values.map(fmt || String).join(' · ')
  }

  /**
   * Render the markdown document. `tokens` is the object from
   * design-tokens.js extractDesignTokens().
   */
  function renderDesignDoc(tokens, opts) {
    if (!tokens) return ''
    const options = opts || {}
    const capturedAt = options.capturedAt || ''
    const source = tokens.url || options.url || 'unknown page'

    const out = []
    out.push(`# Design tokens — ${tokens.title || source}`)
    out.push('')
    out.push(`Source: ${source}`)
    if (capturedAt) out.push(`Captured: ${capturedAt}`)
    out.push(`Sampled ${tokens.elements} rendered elements.`)
    out.push('')
    out.push('Extracted from **computed styles**, not the authored CSS — most real sites')
    out.push('serve stylesheets cross-origin, where the rules are unreadable. Read the')
    out.push('**Limits** section at the end before treating anything here as complete.')
    out.push('')

    out.push('## Palette')
    out.push('')
    out.push(paletteSection(tokens.palette))
    out.push('')

    out.push('## Type scale')
    out.push('')
    out.push(typeSection(tokens.type))
    out.push('')

    out.push('## Spacing')
    out.push('')
    out.push(spacingSection(tokens.spacing))
    out.push('')

    out.push('## Radii')
    out.push('')
    out.push(listOrNone(tokens.radii, fmtPx))
    out.push('')

    out.push('## Shadows')
    out.push('')
    out.push(tokens.shadows.length ? tokens.shadows.map((s) => `- \`${s.value}\` (${s.count})`).join('\n') : '_none observed_')
    out.push('')

    out.push('## Borders')
    out.push('')
    out.push(listOrNone(tokens.borders.map((b) => b.value)))
    out.push('')

    out.push('## Z-index bands')
    out.push('')
    out.push(listOrNone(tokens.zIndex))
    out.push('')

    out.push('## Breakpoints')
    out.push('')
    if (tokens.breakpoints && tokens.breakpoints.length) {
      out.push(`${tokens.breakpoints.map((w) => `${w}px`).join(' · ')}`)
      out.push('')
      out.push('_Derived by re-sampling the page at several widths and keeping those where')
      out.push('the token set actually changed — not read from `@media` rules and not assumed_')
      out.push('_from a framework default._')
    } else {
      out.push('_Not probed._ Breakpoints require re-sampling at multiple viewport widths;')
      out.push('this capture ran at a single width. No `@media` rules were read — they are')
      out.push('unreadable cross-origin, which is the trap this whole module avoids.')
    }
    out.push('')

    out.push('## Limits')
    out.push('')
    out.push('This document records what the page **rendered**, not what its stylesheet')
    out.push('**authored**. Specifically absent:')
    out.push('')
    for (const limit of LIMITS) out.push(`- ${limit}`)
    out.push('')

    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
  }

  const api = { renderDesignDoc, LIMITS, fmtPx, table }
  root.ChodaDesignDoc = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
