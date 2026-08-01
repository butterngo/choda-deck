// @vitest-environment happy-dom
// TASK-1553 — shared DOM traversal. Needs a DOM (happy-dom).
const domWalk = require('./dom-walk.js')
const { walk, textLength, linkTextLength, linkDensity, isSkippedTag, tagOf } = domWalk

const tagsVisited = (html, opts) => {
  document.body.innerHTML = html
  const seen = []
  walk(document.body, ({ tag }) => seen.push(tag), opts)
  return seen
}

describe('dual-mode export (AC-1)', () => {
  it('exposes the same api on globalThis and module.exports', () => {
    expect(globalThis.ChodaDomWalk).toBe(domWalk)
    expect(typeof globalThis.ChodaDomWalk.walk).toBe('function')
  })
})

describe('walk', () => {
  it('visits elements in document order', () => {
    expect(tagsVisited('<div><span>a</span><p>b</p></div>')).toEqual(['BODY', 'DIV', 'SPAN', 'P'])
  })

  it('skips the root when includeRoot is false', () => {
    expect(tagsVisited('<div><p>a</p></div>', { includeRoot: false })).toEqual(['DIV', 'P'])
  })

  it('never descends into script, style or an embedded document', () => {
    const seen = tagsVisited('<p>a</p><script>var x</script><style>.a{}</style><iframe></iframe>')
    expect(seen).toEqual(['BODY', 'P'])
  })

  it('prunes a subtree when the visitor returns false, and continues elsewhere', () => {
    document.body.innerHTML = '<nav><a href="/">x</a></nav><div><p>keep</p></div>'
    const seen = []
    walk(document.body, ({ tag }) => {
      seen.push(tag)
      if (tag === 'NAV') return false
    })
    expect(seen).toEqual(['BODY', 'NAV', 'DIV', 'P'])
    expect(seen).not.toContain('A')
  })

  it('returns the number of elements visited', () => {
    document.body.innerHTML = '<div><p>a</p></div>'
    expect(walk(document.body, () => {})).toBe(3)
  })

  it('handles a deeply nested tree without blowing the stack', () => {
    // Iterative by design: a recursive walk dies here, and a content script that throws
    // takes the whole isolated-world bundle with it.
    //
    // Built detached, node by node. Assigning this depth via innerHTML — or attaching it
    // to the document — overflows happy-dom's OWN recursive tree machinery first, which
    // would make the test fail for a reason that has nothing to do with the walk.
    const root = document.createElement('div')
    let tip = root
    for (let i = 0; i < 6000; i++) {
      const next = document.createElement('div')
      tip.appendChild(next)
      tip = next
    }
    tip.textContent = 'x'
    let visited = 0
    expect(() => walk(root, () => visited++)).not.toThrow()
    expect(visited).toBe(6001)
  })

  it('is a no-op for a null root or a non-function visitor', () => {
    expect(walk(null, () => {})).toBe(0)
    expect(walk(document.body, null)).toBe(0)
  })
})

describe('text measures', () => {
  it('collapses whitespace when measuring text length', () => {
    document.body.innerHTML = '<p>  a   b \n c  </p>'
    expect(textLength(document.body.firstElementChild)).toBe(5) // "a b c"
  })

  it('sums only anchor text for linkTextLength', () => {
    document.body.innerHTML = '<div>plain <a href="/">four</a><a href="/">four</a></div>'
    expect(linkTextLength(document.body.firstElementChild)).toBe(8)
  })

  it('scores a nav as high link density and a paragraph as low', () => {
    document.body.innerHTML = '<nav><a href="/a">alpha</a> <a href="/b">beta</a></nav>'
    // "alpha beta" is 10 chars of which 9 are link text — the separating space is the
    // only non-link character, so 0.9 is the exact value, not a floor to clear.
    expect(linkDensity(document.body.firstElementChild)).toBeGreaterThanOrEqual(0.9)

    document.body.innerHTML = `<p>${'ordinary prose without links. '.repeat(5)}<a href="/x">one</a></p>`
    expect(linkDensity(document.body.firstElementChild)).toBeLessThan(0.1)
  })

  it('returns 0, not NaN, for an element with no text', () => {
    document.body.innerHTML = '<div></div>'
    // A NaN here propagates silently through every downstream score comparison.
    expect(linkDensity(document.body.firstElementChild)).toBe(0)
    expect(Number.isNaN(linkDensity(document.body.firstElementChild))).toBe(false)
  })

  it('measures nothing for null without throwing', () => {
    expect(textLength(null)).toBe(0)
    expect(linkTextLength(null)).toBe(0)
    expect(linkDensity(null)).toBe(0)
  })
})

describe('helpers', () => {
  it('uppercases tag names and tolerates null', () => {
    document.body.innerHTML = '<p>a</p>'
    expect(tagOf(document.body.firstElementChild)).toBe('P')
    expect(tagOf(null)).toBe('')
  })

  it('identifies skipped tags', () => {
    document.body.innerHTML = '<script></script><p></p>'
    expect(isSkippedTag(document.body.children[0])).toBe(true)
    expect(isSkippedTag(document.body.children[1])).toBe(false)
  })
})
