// @vitest-environment happy-dom
// TASK-1555 — element picker. Needs a DOM (happy-dom).
require('./selector.js') // side-effect: globalThis.ChodaSelector
const {
  startPicker,
  buildPick,
  formatPick,
  captureStyles,
  ancestorChain,
  describe: label,
  cropRect,
  CAPTURED_PROPS,
  OVERLAY_ID
} = require('./picker.js')

/** happy-dom has no layout engine — getBoundingClientRect returns zeros. Stub it. */
function withRect(el, rect) {
  el.getBoundingClientRect = () => ({
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height
  })
  return el
}

const html = (markup) => {
  document.body.innerHTML = markup
  return document.body.firstElementChild
}

describe('overlay lifecycle (AC-1)', () => {
  it('mounts an overlay host and removes it on cancel', () => {
    const picker = startPicker(document, {})
    expect(document.getElementById(OVERLAY_ID)).not.toBeNull()
    expect(picker.active).toBe(true)
    picker.cancel()
    expect(document.getElementById(OVERLAY_ID)).toBeNull()
    expect(picker.active).toBe(false)
  })

  it('removes the overlay on Escape and reports the cancellation', () => {
    let cancelled = false
    startPicker(document, { onCancel: () => (cancelled = true) })
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(cancelled).toBe(true)
    expect(document.getElementById(OVERLAY_ID)).toBeNull()
  })

  it('ignores keys other than Escape', () => {
    let cancelled = false
    const picker = startPicker(document, { onCancel: () => (cancelled = true) })
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(cancelled).toBe(false)
    expect(picker.active).toBe(true)
    picker.cancel()
  })

  it('freezes the selection on click and stops the picker first', () => {
    const el = withRect(html('<button id="go">Go</button>'), { x: 10, y: 20, width: 84, height: 28 })
    let picked = null
    let activeDuringHandler = null
    const picker = startPicker(document, {
      onPick: (p) => {
        picked = p
        activeDuringHandler = picker.active
      }
    })
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    expect(picked).not.toBeNull()
    expect(picked.selector).toBe('#go')
    // Stopped BEFORE the handler runs, so a handler that opens a dialog is not fighting
    // an overlay still tracking the pointer.
    expect(activeDuringHandler).toBe(false)
  })

  it('cancel is idempotent and leaves no residual node', () => {
    const picker = startPicker(document, {})
    picker.cancel()
    expect(() => picker.cancel()).not.toThrow()
    expect(document.querySelectorAll(`#${OVERLAY_ID}`)).toHaveLength(0)
  })

  it('is a no-op on a document with no body', () => {
    expect(() => startPicker(null, {}).cancel()).not.toThrow()
  })
})

describe('does not pollute the host page (AC-7)', () => {
  it('adds no stylesheet to the page while active', () => {
    document.head.innerHTML = '<style>.page{color:#111}</style>'
    const before = document.styleSheets.length
    const picker = startPicker(document, {})
    expect(document.styleSheets.length).toBe(before)
    picker.cancel()
    expect(document.styleSheets.length).toBe(before)
  })

  it('renders into a closed shadow root the page cannot read', () => {
    const picker = startPicker(document, {})
    const host = document.getElementById(OVERLAY_ID)
    // closed → shadowRoot is null from the outside. The highlight box therefore cannot
    // be found, restyled, or scraped by the page.
    expect(host.shadowRoot).toBeNull()
    picker.cancel()
  })

  it('leaves the page DOM otherwise untouched', () => {
    html('<div id="content"><p>text</p></div>')
    const before = document.body.innerHTML
    const picker = startPicker(document, {})
    picker.cancel()
    expect(document.body.innerHTML).toBe(before)
  })
})

describe('selector round-trip (AC-2)', () => {
  it('resolves back to the same element via data-testid', () => {
    const el = html('<div><button data-testid="submit-order">Go</button></div>').firstElementChild
    const pick = buildPick(el)
    expect(pick.selector).toBe('[data-testid="submit-order"]')
    expect(document.querySelector(pick.selector)).toBe(el)
  })

  it('resolves back to the same element by structural position alone', () => {
    document.body.innerHTML = '<section><p>a</p><p>b</p><p>c</p></section>'
    const el = document.querySelectorAll('p')[1]
    const pick = buildPick(el)
    expect(document.querySelector(pick.selector)).toBe(el)
  })

  it('prefers a testid over an id, and an id over a structural path', () => {
    const withTestId = html('<button data-testid="t" id="i">x</button>')
    expect(buildPick(withTestId).selector).toBe('[data-testid="t"]')
    const withId = html('<button id="i">x</button>')
    expect(buildPick(withId).selector).toBe('#i')
  })

  it('LIMIT — an element inside a shadow root is not addressable by this selector', () => {
    // Recorded rather than silently unsupported (AC-2 allows either). document.querySelector
    // cannot pierce a shadow boundary, so a pick inside a web component resolves to the
    // HOST at best. Anything better needs a selector format that encodes the boundary.
    const host = html('<div id="host"></div>')
    const shadow = host.attachShadow({ mode: 'open' })
    const inner = document.createElement('button')
    inner.id = 'inner'
    shadow.appendChild(inner)
    const pick = buildPick(inner)
    expect(document.querySelector(pick.selector)).toBeNull()
  })
})

describe('captured computed styles (AC-3)', () => {
  it('captures only the curated subset, never the full property list', () => {
    document.head.innerHTML = '<style>#b{display:flex;font-size:11px;color:#FFFFFF}</style>'
    const el = html('<button id="b">Go</button>')
    const styles = captureStyles(el, window)
    for (const key of Object.keys(styles)) expect(CAPTURED_PROPS).toContain(key)
  })

  it('keeps the property list small and explicit so it cannot silently grow', () => {
    // The guard: a future edit that dumps every computed property fails here rather
    // than quietly shipping a 340-line payload per pick.
    expect(CAPTURED_PROPS.length).toBeLessThanOrEqual(40)
    expect(new Set(CAPTURED_PROPS).size).toBe(CAPTURED_PROPS.length)
  })

  it('captures the parent styles too — a layout bug usually lives in the container', () => {
    document.head.innerHTML = '<style>.row{display:flex;gap:32px}</style>'
    html('<div class="row"><button id="b">Go</button></div>')
    const pick = buildPick(document.getElementById('b'), { window })
    expect(pick.parentStyles.display).toBe('flex')
  })

  it('falls back to the element\'s own view when the caller passes none', () => {
    // Passing null is not "unreadable" — ownerDocument.defaultView still resolves, and
    // relying on that is what lets buildPick work without threading a window through.
    expect(captureStyles(html('<div>x</div>'), null).display).toBe('block')
  })

  it('returns an empty object rather than throwing when getComputedStyle fails', () => {
    const throwingView = {
      getComputedStyle() {
        throw new Error('detached node')
      }
    }
    expect(captureStyles(html('<div>x</div>'), throwingView)).toEqual({})
  })

  it('returns an empty object for an element with no view at all', () => {
    expect(captureStyles({ tagName: 'DIV' }, null)).toEqual({})
  })
})

describe('crop maths (AC-4)', () => {
  it('maps a CSS rect to device pixels at DPR 1', () => {
    expect(cropRect({ x: 10, y: 20, width: 84, height: 28 }, 1, 1280, 720)).toEqual({
      x: 10,
      y: 20,
      width: 84,
      height: 28
    })
  })

  it('doubles every coordinate at DPR 2', () => {
    // The retina trap: cropping with raw CSS pixels yields the top-left quarter of the
    // element and looks plausible enough to ship.
    expect(cropRect({ x: 10, y: 20, width: 84, height: 28 }, 2, 2560, 1440)).toEqual({
      x: 20,
      y: 40,
      width: 168,
      height: 56
    })
  })

  it('clamps a rect that overhangs the captured viewport', () => {
    const crop = cropRect({ x: 1200, y: 700, width: 400, height: 200 }, 1, 1280, 720)
    expect(crop).toEqual({ x: 1200, y: 700, width: 80, height: 20 })
  })

  it('clamps a negative origin to zero — a partly scrolled-off element', () => {
    expect(cropRect({ x: -30, y: -10, width: 100, height: 50 }, 1, 1280, 720)).toEqual({
      x: 0,
      y: 0,
      width: 70,
      height: 40
    })
  })

  it('returns null for an element entirely outside the captured area', () => {
    expect(cropRect({ x: 5000, y: 5000, width: 100, height: 50 }, 1, 1280, 720)).toBeNull()
  })

  it('returns null for a zero-area rect rather than a canvas-throwing crop', () => {
    expect(cropRect({ x: 10, y: 10, width: 0, height: 40 }, 1, 1280, 720)).toBeNull()
  })

  it('treats a missing or nonsense DPR as 1 instead of collapsing the crop', () => {
    const expected = { x: 10, y: 20, width: 84, height: 28 }
    expect(cropRect({ x: 10, y: 20, width: 84, height: 28 }, undefined, 1280, 720)).toEqual(expected)
    expect(cropRect({ x: 10, y: 20, width: 84, height: 28 }, 0, 1280, 720)).toEqual(expected)
  })

  it('reports a crop whose dimensions match the picked rect (AC-4 assertion)', () => {
    const el = withRect(html('<button>Go</button>'), { x: 10, y: 20, width: 84, height: 28 })
    const pick = buildPick(el)
    const crop = cropRect(pick.rect, 1, 1280, 720)
    expect(crop.width).toBe(pick.rect.width)
    expect(crop.height).toBe(pick.rect.height)
  })
})

describe('payload', () => {
  it('caps outerHTML so one huge element cannot dominate the capture', () => {
    const el = html(`<div>${'x'.repeat(20000)}</div>`)
    const pick = buildPick(el, { maxHtml: 500 })
    expect(pick.outerHTML.length).toBeLessThanOrEqual(600)
    expect(pick.outerHTML).toContain('truncated')
  })

  it('records a short ancestor chain, nearest first, stopping before <html>', () => {
    html('<main><section><div class="row"><button id="b">x</button></div></section></main>')
    const chain = ancestorChain(document.getElementById('b'))
    expect(chain[0]).toBe('div.row')
    expect(chain.length).toBeLessThanOrEqual(4)
    expect(chain).not.toContain('html')
  })

  it('labels an element with tag, id and up to three classes', () => {
    expect(label(html('<button id="go" class="btn btn--primary is-loading extra">x</button>'))).toBe(
      'button#go.btn.btn--primary.is-loading'
    )
  })

  it('returns null for a non-element rather than a half-built pick', () => {
    expect(buildPick(null)).toBeNull()
    expect(buildPick({})).toBeNull()
  })
})

describe('provenance is stamped at pick time (AC-5)', () => {
  it('keeps the page the element was picked on, not a later one', () => {
    // Two DIFFERENT urls. With the same url on both ends, a correct implementation and
    // a broken one produce byte-identical output and the test proves nothing — the trap
    // TASK-1552 caught on its first AC-4 attempt.
    const PICKED_ON = 'https://app.example.com/orders/new'
    const SENT_FROM = 'https://unrelated.example.com/dashboard'

    const el = html('<button id="go">Go</button>')
    const pick = buildPick(el, { sourceUrl: PICKED_ON })

    // …user navigates, then hits Send. The pick still names where it came from.
    expect(pick.sourceUrl).toBe(PICKED_ON)
    expect(pick.sourceUrl).not.toBe(SENT_FROM)
  })

  it('falls back to the document url when the caller stamps nothing', () => {
    const pick = buildPick(html('<button>x</button>'))
    expect(pick.sourceUrl).toBe(document.location.href)
  })
})

describe('formatPick', () => {
  it('renders selector, size, styles, html and the note', () => {
    const el = withRect(html('<button id="go" class="btn">Go</button>'), {
      x: 10,
      y: 20,
      width: 84,
      height: 28
    })
    const md = formatPick(buildPick(el, { window }), 'text is clipped')
    expect(md).toContain('**Selector:** `#go`')
    expect(md).toContain('84×28')
    expect(md).toContain('```html')
    expect(md).toContain("**What's wrong**")
    expect(md).toContain('text is clipped')
  })

  it('omits the note section entirely when there is no note', () => {
    const md = formatPick(buildPick(html('<button>x</button>'), { window }))
    expect(md).not.toContain("What's wrong")
  })

  it('returns an empty string for a null pick', () => {
    expect(formatPick(null)).toBe('')
  })
})
