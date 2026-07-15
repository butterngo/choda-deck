// @vitest-environment happy-dom
// TASK-1412 — cssPath stability. Needs a real DOM (happy-dom).
const { cssPath } = require('./selector.js')

function setBody(html) {
  document.body.innerHTML = html
}

describe('cssPath (AC-2)', () => {
  it('prefers data-testid', () => {
    setBody('<button data-testid="add">Add</button>')
    const el = document.querySelector('button')
    expect(cssPath(el)).toBe('[data-testid="add"]')
  })

  it('falls back to id', () => {
    setBody('<div><a id="checkout">Go</a></div>')
    const el = document.querySelector('a')
    expect(cssPath(el)).toBe('#checkout')
  })

  it('falls back to aria-label with tag', () => {
    setBody('<nav><button aria-label="Close menu">x</button></nav>')
    const el = document.querySelector('button')
    const sel = cssPath(el)
    expect(sel.startsWith('button[aria-label=')).toBe(true)
    expect(document.querySelector(sel)).toBe(el)
  })

  it('builds a structural path that uniquely re-selects the element', () => {
    setBody(`
      <main id="root">
        <ul><li>a</li><li><span>target</span></li><li>c</li></ul>
      </main>
    `)
    const target = document.querySelectorAll('li')[1].querySelector('span')
    const sel = cssPath(target)
    // anchored at the nearest id (#root), so it starts there
    expect(sel.startsWith('#root')).toBe(true)
    const reselected = document.querySelectorAll(sel)
    expect(reselected).toHaveLength(1)
    expect(reselected[0]).toBe(target)
  })
})
