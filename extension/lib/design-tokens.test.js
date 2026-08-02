// @vitest-environment happy-dom
// TASK-1554 — design-token extraction. Needs a DOM with computed styles (happy-dom).
require('./dom-walk.js') // side-effect: globalThis.ChodaDomWalk
require('./redact.js') // side-effect: globalThis.ChodaRedact, needed by snapshot.js
const {
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
  toHex
} = require('./design-tokens.js')
const { serializeDom } = require('./snapshot.js')

/** Style the page via a real stylesheet, so values arrive through the cascade. */
function styled(css, html) {
  document.head.innerHTML = `<style>${css}</style>`
  document.body.innerHTML = html
}

/** Make every stylesheet throw on cssRules, exactly as a cross-origin sheet does. */
function makeSheetsCrossOrigin() {
  for (const sheet of Array.from(document.styleSheets)) {
    Object.defineProperty(sheet, 'cssRules', {
      configurable: true,
      get() {
        throw new Error('SecurityError: cannot access rules of a cross-origin stylesheet')
      }
    })
  }
}

// AC-1 — extraction must survive a page whose CSS the authored-CSS path cannot read.
//
// Modelled as: styles that apply while `document.styleSheets` yields collectCss nothing.
// That is structurally what a cross-origin sheet does — the rules style the page, the
// authored-CSS path sees zero — and it is reproducible without a network fetch. (An
// actual `<link>` to a CDN would make happy-dom attempt real DNS, which is slow and
// flaky in CI for no added fidelity.)
//
// ENVIRONMENT LIMIT, stated because it bounds what this proves. A real cross-origin
// sheet cannot be exercised here at all: happy-dom implements getComputedStyle BY
// walking cssRules, so a sheet that throws breaks its computed styles outright, which no
// real engine does. These tests prove the two paths are INDEPENDENT — the substance of
// AC-1 — but the live cross-origin case is deferred to the human check (AC-8).
describe('unreadable stylesheets (AC-1)', () => {
  const INLINE = `
    <h1 style="color:#1B1B1B;font-size:48px;font-weight:700">Title</h1>
    <div style="color:#1B1B1B;background-color:#FAFAFA;padding:16px;border-radius:8px;font-size:16px">
      <p style="color:#1B1B1B;font-size:16px">Body copy here.</p>
    </div>
    <a style="color:#FFFFFF;background-color:#FF7759;padding:8px;border-radius:4px;font-size:14px">Go</a>`

  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = INLINE
    expect(document.styleSheets.length).toBe(0) // the premise, asserted not assumed
  })

  it('still extracts a palette and type scale when no stylesheet is readable', () => {
    const tokens = extractDesignTokens(document)
    expect(tokens.palette.map((p) => p.hex)).toContain('#FF7759')
    expect(tokens.type.map((t) => t.size)).toContain(48)
  })

  it('and the authored-CSS path returns nothing on that same page', () => {
    // THE DISCRIMINATOR. Without this half, the test above could be passing because the
    // CSS was readable all along — it would prove nothing about the two paths being
    // independent, which is the whole reason this module exists.
    expect(serializeDom(document).css.trim()).toBe('')
    expect(extractDesignTokens(document).palette.length).toBeGreaterThan(0)
  })

  it('confirms collectCss DOES see a same-origin sheet, so the empty result above is real', () => {
    // Guards the guard: proves collectCss returning '' is caused by the sheet being
    // unreachable, not by serializeDom being broken or the page being empty.
    document.head.innerHTML = '<style>.readable{color:#010203}</style>'
    expect(serializeDom(document).css.trim()).not.toBe('')
  })

  it('does not abort the whole extraction when one element cannot be read', () => {
    // A partial token set beats none. Forced here by making cssRules throw, which in
    // happy-dom breaks every computed read — an extreme case of the same failure.
    document.head.innerHTML = '<style>.a{color:#112233}</style>'
    document.body.innerHTML = '<div class="a">a</div>'
    makeSheetsCrossOrigin()
    expect(() => extractDesignTokens(document)).not.toThrow()
    expect(collectTokens(document).unreadable).toBeGreaterThan(0)
  })
})

describe('colour parsing', () => {
  it.each([
    ['#3B82F6', { r: 59, g: 130, b: 246, a: 1 }],
    ['#3b82f6', { r: 59, g: 130, b: 246, a: 1 }],
    ['rgb(59, 130, 246)', { r: 59, g: 130, b: 246, a: 1 }],
    ['rgba(59, 130, 246, 0.5)', { r: 59, g: 130, b: 246, a: 0.5 }],
    ['#abc', { r: 170, g: 187, b: 204, a: 1 }]
  ])('parses %s', (input, expected) => {
    expect(parseColor(input)).toEqual(expected)
  })

  it.each(['transparent', 'rgba(0, 0, 0, 0)', 'currentcolor', 'inherit', 'none', '', 'not-a-colour', null, 42])(
    'returns null for %s',
    (input) => {
      expect(parseColor(input)).toBeNull()
    }
  )

  it('round-trips through toHex', () => {
    expect(toHex(parseColor('rgb(59, 130, 246)'))).toBe('#3B82F6')
  })
})

describe('near-duplicate colour merging (AC-3)', () => {
  it('collapses hex, rgb and a near-miss of the same blue into one swatch', () => {
    const entries = [
      { color: parseColor('#3B82F6'), count: 10, usedOn: 'text' },
      { color: parseColor('rgb(59,130,246)'), count: 5, usedOn: 'text' },
      { color: parseColor('#3b82f7'), count: 3, usedOn: 'text' }
    ]
    const clusters = clusterColors(entries)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].count).toBe(18)
    expect(clusters[0].hex).toBe('#3B82F6')
  })

  it('keeps genuinely different colours apart', () => {
    const entries = [
      { color: parseColor('#3B82F6'), count: 10, usedOn: 'text' },
      { color: parseColor('#FF7759'), count: 8, usedOn: 'background' },
      { color: parseColor('#1B1B1B'), count: 40, usedOn: 'text' }
    ]
    expect(clusterColors(entries)).toHaveLength(3)
  })

  it('names the cluster after its most-used member, not the first seen', () => {
    // A one-off anti-aliasing variant must not name the swatch.
    const entries = [
      { color: parseColor('#3b82f7'), count: 2, usedOn: 'text' },
      { color: parseColor('#3B82F6'), count: 90, usedOn: 'text' }
    ]
    expect(clusterColors(entries)[0].hex).toBe('#3B82F6')
  })

  it('never merges across a large alpha difference', () => {
    // Same RGB, different alpha: what you see differs, so they are different tokens.
    const entries = [
      { color: parseColor('rgba(0,0,0,1)'), count: 5, usedOn: 'text' },
      { color: parseColor('rgba(0,0,0,0.4)'), count: 5, usedOn: 'background' }
    ]
    expect(clusterColors(entries)).toHaveLength(2)
    expect(colorDistance(parseColor('rgba(0,0,0,1)'), parseColor('rgba(0,0,0,0.4)'))).toBe(Infinity)
  })

  it('ranks by usage count, descending', () => {
    const entries = [
      { color: parseColor('#111111'), count: 3, usedOn: 'text' },
      { color: parseColor('#FF0000'), count: 30, usedOn: 'text' },
      { color: parseColor('#00FF00'), count: 12, usedOn: 'text' }
    ]
    expect(clusterColors(entries).map((c) => c.count)).toEqual([30, 12, 3])
  })
})

describe('spacing grid detection (AC-4)', () => {
  it('reports a 4px grid for 4/8/12/16/24/32', () => {
    expect(detectGrid([4, 8, 12, 16, 24, 32])).toBe(4)
  })

  it('reports 8 rather than 4 when every value is a multiple of 8', () => {
    // Prefers the largest candidate that covers, so an 8px system is not reported as 4px.
    expect(detectGrid([8, 16, 24, 32, 48, 64])).toBe(8)
  })

  it('reports NO grid for arbitrary values rather than inventing one', () => {
    expect(detectGrid([3, 7, 11, 13, 19, 23])).toBeNull()
  })

  it('does not fall back to 1px, which would divide everything and mean nothing', () => {
    expect(detectGrid([5, 9, 14, 21, 27, 33], [1, 2, 4, 8])).not.toBe(1)
  })

  it('tolerates a few off-grid values inside a mostly-consistent scale', () => {
    expect(detectGrid([4, 8, 12, 16, 20, 24, 28, 32, 36, 13])).toBe(4)
  })

  it('returns null when there is too little data to call it', () => {
    expect(detectGrid([8, 16])).toBeNull()
    expect(detectGrid([])).toBeNull()
  })
})

describe('parsePx', () => {
  it.each([
    ['16px', 16],
    ['0px', 0],
    ['-4px', -4],
    ['1.5px', 1.5]
  ])('parses %s', (input, expected) => {
    expect(parsePx(input)).toBe(expected)
  })

  it.each(['auto', '1em', '50%', 'normal', '', null])('returns null for %s', (input) => {
    expect(parsePx(input)).toBeNull()
  })
})

describe('collection from a rendered page', () => {
  beforeEach(() => {
    styled(
      `.a { color: #1B1B1B; font-size: 16px; padding: 8px; border-radius: 4px }
       .b { color: #FF7759; font-size: 32px; margin: 16px; border-radius: 8px }
       .c { box-shadow: 0 1px 2px rgba(0,0,0,0.1); border-top: 1px solid #DDDDDD; z-index: 10 }`,
      '<div class="a">a</div><div class="b">b</div><div class="c">c</div>'
    )
  })

  it('ranks the type scale and tags each entry with the element it appeared on', () => {
    const tokens = extractDesignTokens(document)
    const sizes = tokens.type.map((t) => t.size)
    expect(sizes).toContain(16)
    expect(sizes).toContain(32)
    expect(tokens.type.every((t) => typeof t.tag === 'string' && t.tag.length)).toBe(true)
  })

  it('collects radii, shadows, borders and z-index', () => {
    const tokens = extractDesignTokens(document)
    expect(tokens.radii).toEqual(expect.arrayContaining([4, 8]))
    expect(tokens.shadows.length).toBeGreaterThan(0)
    expect(tokens.borders.length).toBeGreaterThan(0)
    expect(tokens.zIndex).toContain(10)
  })

  it('counts the elements it sampled', () => {
    expect(extractDesignTokens(document).elements).toBeGreaterThan(0)
  })

  it('ignores fully transparent backgrounds instead of reporting them as a swatch', () => {
    styled('.x { background-color: transparent; color: #123456 }', '<div class="x">x</div>')
    const hexes = extractDesignTokens(document).palette.map((p) => p.hex)
    expect(hexes).toContain('#123456')
    expect(hexes).not.toContain('#000000')
  })

  it('does not report a border colour on an element with no border', () => {
    // borderTopColor is populated regardless of width; without the width check every
    // element would contribute its text colour a second time under a border label.
    styled('.x { color: #AA0000; border: 0 }', '<div class="x">x</div>')
    const roles = extractDesignTokens(document).palette.flatMap((p) => p.usedOn)
    expect(roles).not.toContain('border')
  })

  it('returns an empty token set for a null document rather than throwing', () => {
    const tokens = extractDesignTokens(null)
    expect(tokens.palette).toEqual([])
    expect(tokens.elements).toBe(0)
  })
})

describe('breakpoint detection (AC-5)', () => {
  it('reports only the widths where the token set actually changes', () => {
    // A resize hook that swaps the stylesheet is how a real @media rule behaves from
    // the outside: below 768 the heading is small, at/above it is large.
    const resize = (width) => {
      styled(
        `h1 { font-size: ${width >= 768 ? 48 : 24}px; color: #111111 }`,
        '<h1>t</h1><p>body</p>'
      )
    }
    const found = detectBreakpoints(document, [320, 480, 768, 1024, 1440], resize)
    expect(found).toEqual([768])
  })

  it('reports nothing for a page whose tokens never change with width', () => {
    const resize = () => styled('h1 { font-size: 32px; color: #111111 }', '<h1>t</h1>')
    expect(detectBreakpoints(document, [320, 768, 1440], resize)).toEqual([])
  })

  it('never guesses a framework default when it cannot resize', () => {
    // No resize hook → no probing → no breakpoints. Emitting Bootstrap's or Tailwind's
    // defaults here would be a fabrication dressed as a measurement.
    expect(detectBreakpoints(document, [768, 1024], null)).toEqual([])
    expect(extractDesignTokens(document).breakpoints).toEqual([])
  })

  it('fingerprints two identical renderings the same and a changed one differently', () => {
    styled('h1 { font-size: 32px; color: #111111 }', '<h1>t</h1>')
    const a = fingerprintTokens(summarize(collectTokens(document)))
    const b = fingerprintTokens(summarize(collectTokens(document)))
    expect(a).toBe(b)
    styled('h1 { font-size: 64px; color: #111111 }', '<h1>t</h1>')
    expect(fingerprintTokens(summarize(collectTokens(document)))).not.toBe(a)
  })
})

// Live findings from the 2026-08-02 cohere.com/blog/embed-4 capture. Each reproduces the
// real shape that produced the defect, not a synthetic case.
describe('live regressions (cohere.com capture)', () => {
  it('titles the doc from the page h1, not document.title with its site suffix', () => {
    document.title = 'Introducing Embed 4: Multimodal search for business | Cohere Blog'
    document.body.innerHTML = '<h1>Introducing Embed 4: Multimodal search for business</h1><p style="color:#111">x</p>'
    const tokens = extractDesignTokens(document)
    expect(tokens.title).toBe('Introducing Embed 4: Multimodal search for business')
    expect(tokens.title).not.toContain('| Cohere Blog')
  })

  it('falls back to document.title when the page has no h1', () => {
    document.title = 'Some Page | Site'
    document.body.innerHTML = '<p style="color:#111">x</p>'
    expect(extractDesignTokens(document).title).toBe('Some Page | Site')
  })

  it('keeps headings in the type scale even when hundreds of divs outrank them', () => {
    // The live failure: one h1 vs 434 divs meant a top-10-by-count scale contained
    // div/a/li/span/img and not a single heading.
    document.head.innerHTML = '<style>h1{font-size:48px}h2{font-size:32px}div{font-size:16px}</style>'
    document.body.innerHTML =
      '<h1>Title</h1><h2>Section</h2>' + '<div>x</div>'.repeat(200)
    const tokens = extractDesignTokens(document)
    const headingTags = tokens.typeHeadings.map((t) => t.tag)
    expect(headingTags).toContain('h1')
    expect(headingTags).toContain('h2')
    expect(tokens.typeBody.every((t) => !/^h[1-6]$/.test(t.tag))).toBe(true)
  })

  it('orders headings h1..h6, not by frequency', () => {
    document.head.innerHTML = '<style>h1{font-size:48px}h3{font-size:24px}</style>'
    document.body.innerHTML = '<h3>a</h3><h3>b</h3><h3>c</h3><h1>once</h1>'
    expect(extractDesignTokens(document).typeHeadings[0].tag).toBe('h1')
  })

  it('excludes negative values from the displayed spacing steps', () => {
    // "-0.5px" appeared among the observed steps live: detectGrid filtered negatives,
    // the display did not.
    document.head.innerHTML = '<style>.a{margin-top:-4px;padding:8px}</style>'
    document.body.innerHTML = '<div class="a">x</div>'
    expect(extractDesignTokens(document).spacing.steps.every((v) => v > 0)).toBe(true)
  })

  it('reports how many distinct values the grid verdict was computed over', () => {
    // Without this the document contradicts itself: a tidy 2/4/6/8 list of the most
    // frequent values sitting under a "none detected" line computed over all of them.
    document.head.innerHTML = '<style>.a{padding:8px;margin:16px}</style>'
    document.body.innerHTML = '<div class="a">x</div>'
    const { spacing } = extractDesignTokens(document)
    expect(typeof spacing.distinctValues).toBe('number')
    expect(spacing.distinctValues).toBeGreaterThanOrEqual(spacing.steps.length)
  })
})
