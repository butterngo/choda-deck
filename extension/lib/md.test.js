// @vitest-environment happy-dom
// TASK-1553 — DOM→markdown serializer. Needs a DOM (happy-dom).
require('./dom-walk.js') // side-effect: sets globalThis.ChodaDomWalk for md.js
const { toMarkdown, escapeInline } = require('./md.js')

const render = (html) => {
  document.body.innerHTML = html
  return toMarkdown(document.body)
}

describe('headings (AC-4)', () => {
  it.each([
    ['h1', '# '],
    ['h2', '## '],
    ['h3', '### '],
    ['h4', '#### '],
    ['h5', '##### '],
    ['h6', '###### ']
  ])('<%s> becomes %s', (tag, prefix) => {
    expect(render(`<${tag}>Title</${tag}>`)).toBe(`${prefix}Title`)
  })

  it('drops a heading that has no text rather than emitting a bare #', () => {
    expect(render('<h2>   </h2><p>body</p>')).toBe('body')
  })
})

describe('lists (AC-4)', () => {
  it('serializes an unordered list as - markers', () => {
    expect(render('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two')
  })

  it('serializes an ordered list as numbers, honouring start', () => {
    expect(render('<ol start="3"><li>three</li><li>four</li></ol>')).toBe('3. three\n4. four')
  })

  it('indents a nested list under its parent item', () => {
    const out = render('<ul><li>outer<ul><li>inner</li></ul></li></ul>')
    expect(out).toBe('- outer\n\n  - inner')
  })

  it('keeps inline emphasis inside an item', () => {
    expect(render('<ul><li><strong>Bold:</strong> rest</li></ul>')).toBe('- **Bold:** rest')
  })
})

describe('tables (AC-4)', () => {
  it('emits a pipe table with a separator row', () => {
    const out = render('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>')
    expect(out).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |')
  })

  it('pads a short row so the column count stays stable', () => {
    const out = render('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></table>')
    expect(out.split('\n')[2]).toBe('| 1 |  |')
  })

  it('escapes a pipe inside a cell so it cannot forge a column', () => {
    const out = render('<table><tr><th>A</th></tr><tr><td>x|y</td></tr></table>')
    expect(out).toContain('| x\\|y |')
  })
})

describe('code (AC-4)', () => {
  it('fences a <pre><code> block', () => {
    expect(render('<pre><code>const a = 1</code></pre>')).toBe('```\nconst a = 1\n```')
  })

  it('takes the language from a language-* class', () => {
    expect(render('<pre><code class="language-ts">let x</code></pre>')).toBe('```ts\nlet x\n```')
  })

  it('widens the fence past a backtick run in the source', () => {
    const out = render('<pre><code>a ``` b</code></pre>')
    expect(out.startsWith('````')).toBe(true)
    expect(out.endsWith('````')).toBe(true)
  })

  it('renders inline <code> with single backticks', () => {
    expect(render('<p>run <code>pnpm test</code> now</p>')).toBe('run `pnpm test` now')
  })
})

describe('links and inline (AC-4)', () => {
  it('renders an anchor as [text](href)', () => {
    expect(render('<p>see <a href="https://x.dev/a">the docs</a></p>')).toBe('see [the docs](https://x.dev/a)')
  })

  it('keeps the words but drops the target for an in-page or javascript: anchor', () => {
    expect(render('<p>go <a href="#tab-2">next</a></p>')).toBe('go next')
    expect(render('<p>go <a href="javascript:void(0)">next</a></p>')).toBe('go next')
  })

  it('renders strong, em and del', () => {
    expect(render('<p><strong>a</strong> <em>b</em> <del>c</del></p>')).toBe('**a** *b* ~~c~~')
  })

  it('references an image rather than inlining it', () => {
    expect(render('<p><img src="/x.png" alt="a chart"></p>')).toBe('![a chart](/x.png)')
  })

  it('turns <br> into a line break inside a paragraph', () => {
    expect(render('<p>one<br>two</p>')).toBe('one\ntwo')
  })
})

describe('blockquote (AC-4)', () => {
  it('prefixes every line with >', () => {
    expect(render('<blockquote><p>a</p><p>b</p></blockquote>')).toBe('> a\n>\n> b')
  })
})

describe('structure', () => {
  it('groups consecutive inline children into one paragraph', () => {
    // The failure this guards: three blocks ("some", "bold", "text") instead of a sentence.
    expect(render('<div>some <b>bold</b> text</div>')).toBe('some **bold** text')
  })

  it('separates sibling blocks with one blank line and collapses empty wrappers', () => {
    expect(render('<div><div><div><p>a</p></div></div><div></div><p>b</p></div>')).toBe('a\n\nb')
  })

  it('skips script and style content', () => {
    expect(render('<p>keep</p><script>var drop = 1</script><style>.drop{}</style>')).toBe('keep')
  })

  it('emits --- for an <hr>', () => {
    expect(render('<p>a</p><hr><p>b</p>')).toBe('a\n\n---\n\nb')
  })

  it('returns an empty string for a null element rather than throwing', () => {
    expect(toMarkdown(null)).toBe('')
  })
})

describe('escaping', () => {
  it('escapes markdown control characters in prose', () => {
    expect(escapeInline('a * b _ c [d]')).toBe('a \\* b \\_ c \\[d\\]')
  })

  it('does not escape ordinary punctuation', () => {
    expect(escapeInline('Cost: $1.50 (approx) — 20% off!')).toBe('Cost: $1.50 (approx) — 20% off!')
  })
})
