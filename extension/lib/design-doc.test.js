// @vitest-environment happy-dom
// TASK-1554 — design.md rendering.
require('./dom-walk.js')
const { renderDesignDoc, LIMITS } = require('./design-doc.js')
const { extractDesignTokens, parseColor } = require('./design-tokens.js')

const tokens = (over) => ({
  elements: 42,
  url: 'https://example.dev/',
  title: 'Example',
  palette: [
    { hex: '#1B1B1B', alpha: 1, count: 412, usedOn: ['text'], merged: [] },
    { hex: '#FF7759', alpha: 1, count: 38, usedOn: ['background'], merged: ['#FF7758'] }
  ],
  type: [{ tag: 'h1', family: 'Inter', size: 48, weight: '700', lineHeight: '52px', count: 3 }],
  spacing: { grid: 4, steps: [4, 8, 16] },
  radii: [4, 8],
  shadows: [{ value: '0 1px 2px rgba(0,0,0,0.1)', count: 5 }],
  borders: [{ value: '1px solid', count: 9 }],
  zIndex: [10, 100],
  breakpoints: [],
  ...over
})

describe('limits section (AC-6)', () => {
  it('is always present', () => {
    expect(renderDesignDoc(tokens())).toContain('## Limits')
  })

  it('names every blind spot computed-style extraction has', () => {
    const md = renderDesignDoc(tokens())
    for (const limit of LIMITS) {
      expect(md).toContain(limit.slice(0, 40))
    }
  })

  it.each([
    ['authored variable names', /CSS variable names/i],
    ['pseudo-states', /:hover/],
    ['dark mode', /dark mode/i],
    ['authored source structure', /authored source structure/i]
  ])('calls out %s', (_label, pattern) => {
    expect(renderDesignDoc(tokens())).toMatch(pattern)
  })

  it('states that missing hover styling is not evidence there is none', () => {
    // The specific misreading the section exists to prevent.
    expect(renderDesignDoc(tokens())).toMatch(/not evidence the site has none/i)
  })
})

describe('sections', () => {
  it('renders the palette as a table with values, counts and roles', () => {
    const md = renderDesignDoc(tokens())
    expect(md).toContain('## Palette')
    expect(md).toContain('| #1B1B1B | 412 | text |')
  })

  it('annotates a translucent swatch with its alpha', () => {
    const md = renderDesignDoc(tokens({ palette: [{ hex: '#000000', alpha: 0.4, count: 3, usedOn: ['background'], merged: [] }] }))
    expect(md).toContain('#000000 @ 40%')
  })

  it('renders the type scale with family, size, weight and line height', () => {
    const md = renderDesignDoc(tokens())
    expect(md).toContain('| h1 | Inter | 48px | 700 | 52px | 3 |')
  })

  it('states the detected base grid', () => {
    expect(renderDesignDoc(tokens())).toContain('Base grid: **4px**')
  })

  it('says no grid was detected rather than omitting the line', () => {
    const md = renderDesignDoc(tokens({ spacing: { grid: null, steps: [3, 7, 11] } }))
    expect(md).toMatch(/Base grid: \*\*none detected\*\*/)
  })

  it('marks empty sections as none observed instead of leaving them blank', () => {
    const md = renderDesignDoc(tokens({ radii: [], shadows: [], borders: [], zIndex: [] }))
    expect((md.match(/_none observed_/g) || []).length).toBeGreaterThanOrEqual(4)
  })
})

describe('breakpoints', () => {
  it('says how they were derived when present', () => {
    const md = renderDesignDoc(tokens({ breakpoints: [768, 1024] }))
    expect(md).toContain('768px · 1024px')
    expect(md).toMatch(/re-sampling/i)
  })

  it('says they were NOT probed rather than implying the page has none', () => {
    const md = renderDesignDoc(tokens({ breakpoints: [] }))
    expect(md).toMatch(/Not probed/i)
    expect(md).toMatch(/single width/i)
  })
})

describe('header', () => {
  it('carries the source url and the sampled element count', () => {
    const md = renderDesignDoc(tokens())
    expect(md).toContain('Source: https://example.dev/')
    expect(md).toContain('Sampled 42 rendered elements')
  })

  it('says up front that this is computed styles, not authored CSS', () => {
    expect(renderDesignDoc(tokens())).toMatch(/computed styles\*\*, not the authored CSS/)
  })

  it('includes a capture timestamp when the caller supplies one', () => {
    expect(renderDesignDoc(tokens(), { capturedAt: '2026-08-01T04:00:00Z' })).toContain('Captured: 2026-08-01T04:00:00Z')
  })

  it('returns an empty string for null tokens rather than throwing', () => {
    expect(renderDesignDoc(null)).toBe('')
  })
})

describe('end to end', () => {
  it('renders a document from a real extraction', () => {
    document.head.innerHTML = '<style>h1{color:#FF7759;font-size:48px}p{color:#1B1B1B;font-size:16px;padding:8px}</style>'
    document.body.innerHTML = '<h1>Title</h1><p>Body</p>'
    const md = renderDesignDoc(extractDesignTokens(document))
    expect(md).toContain('# Design tokens')
    expect(md).toContain('#FF7759')
    expect(md).toContain('48px')
    expect(md).toContain('## Limits')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('never leaves a run of three or more blank lines', () => {
    expect(renderDesignDoc(tokens({ radii: [], shadows: [] }))).not.toMatch(/\n{3,}/)
  })

  it('is stable across two renders of the same tokens', () => {
    const t = tokens()
    expect(renderDesignDoc(t)).toBe(renderDesignDoc(t))
  })

  it('does not leak a raw parsed colour object into the markdown', () => {
    const t = tokens({ palette: [{ hex: '#123456', alpha: 1, count: 1, usedOn: ['text'], merged: [], color: parseColor('#123456') }] })
    expect(renderDesignDoc(t)).not.toContain('[object Object]')
  })
})

describe('live regressions (cohere.com capture)', () => {
  const split = (over) =>
    tokens({
      typeHeadings: [{ tag: 'h1', family: 'Unica77', size: 48, weight: '600', lineHeight: '52px', count: 1 }],
      typeBody: [{ tag: 'div', family: 'Unica77', size: 16, weight: '400', lineHeight: '24px', count: 434 }],
      ...over
    })

  it('gives headings their own table, above the frequency-ranked body rows', () => {
    const md = renderDesignDoc(split())
    expect(md).toContain('**Headings**')
    expect(md).toContain('**Body & UI**')
    expect(md.indexOf('**Headings**')).toBeLessThan(md.indexOf('**Body & UI**'))
    expect(md).toContain('| h1 | Unica77 | 48px |')
  })

  it('says so explicitly when a page rendered no headings at all', () => {
    const md = renderDesignDoc(split({ typeHeadings: [] }))
    expect(md).toContain('_no h1–h6 rendered on this page_')
  })

  it('reconciles a "none detected" grid with the tidy step list under it', () => {
    const md = renderDesignDoc(
      tokens({ spacing: { grid: null, steps: [2, 4, 6, 8], distinctValues: 312, onGrid: 0 } })
    )
    expect(md).toContain('312 distinct values were observed')
    expect(md).toMatch(/Showing the 4 most frequent of 312/)
  })

  it('quantifies a detected grid rather than just naming it', () => {
    const md = renderDesignDoc(
      tokens({ spacing: { grid: 4, steps: [4, 8, 16], distinctValues: 20, onGrid: 18 } })
    )
    expect(md).toContain('Base grid: **4px** — 18 of 20 distinct values sit on it.')
  })
})

describe('grid verdict distinguishes no-data from no-pattern', () => {
  it('says "too few to judge" when there is not enough data', () => {
    // detectGrid needs >= 4 positive values. Reporting "too few share a common step"
    // here would be a claim about the page made from no evidence.
    const md = renderDesignDoc(tokens({ spacing: { grid: null, steps: [8, 16], distinctValues: 2, onGrid: 0 } }))
    expect(md).toContain('only 2 distinct spacing values observed, too few to judge')
    expect(md).not.toContain('too few share a common step')
  })

  it('says "too few share a common step" only once there IS enough data', () => {
    const md = renderDesignDoc(tokens({ spacing: { grid: null, steps: [3, 7, 11, 13], distinctValues: 40, onGrid: 0 } }))
    expect(md).toContain('40 distinct values were observed and too few share a common step')
  })

  it('handles a page with no spacing at all', () => {
    const md = renderDesignDoc(tokens({ spacing: { grid: null, steps: [], distinctValues: 0, onGrid: 0 } }))
    expect(md).toContain('no spacing values observed')
  })
})
