// @vitest-environment happy-dom
// TASK-1553 — main-content extraction. Needs a DOM (happy-dom).
require('./dom-walk.js') // side-effect: globalThis.ChodaDomWalk
require('./md.js') // side-effect: globalThis.ChodaMd
const { extractPageMarkdown, rawPageText, findMain, cleanSubtree, isChrome } = require('./readability.js')
const cohere = require('./__fixtures__/cohere-embed4.js')

function loadCohere() {
  document.title = cohere.TITLE
  document.body.innerHTML = cohere.html()
}

describe('single shared traversal (AC-1)', () => {
  // Strips BOTH comment styles: the guard is about what the code does, and a block
  // comment explaining why querySelector is avoided must not trip it. (It did, on the
  // first run after this comment was written — the guard works.)
  const source = () =>
    require('fs')
      .readFileSync(require.resolve('./readability.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')

  it('crosses the DOM only through ChodaDomWalk', () => {
    // Asserted against the source, because nothing about the OUTPUT differs between a
    // dom-walk traversal and a querySelectorAll one — a behavioural test here could not
    // fail, and AC-1 is precisely a claim about how the module is built.
    expect(source()).not.toMatch(/querySelector/)
    expect(source()).toMatch(/walkApi\.walk\(/)
  })

  it('exposes readability and md dual-mode, like every other lib in this bundle', () => {
    expect(globalThis.ChodaReadability).toBeTruthy()
    expect(globalThis.ChodaMd).toBeTruthy()
    expect(globalThis.ChodaDomWalk).toBeTruthy()
    expect(typeof globalThis.ChodaReadability.extractPageMarkdown).toBe('function')
  })
})

describe('the INBOX-1642 page (AC-2)', () => {
  beforeEach(loadCohere)

  it('starts at the article heading, not the site title', () => {
    const { markdown } = extractPageMarkdown(document)
    expect(markdown.startsWith(`# ${cohere.ARTICLE_HEADING}`)).toBe(true)
    // The " | Cohere Blog" suffix is a document.title artefact; the article's own h1
    // is the real title and the extract should prefer it.
    expect(markdown).not.toContain('| Cohere Blog')
  })

  it('drops the cookie-consent paragraph', () => {
    const { markdown } = extractPageMarkdown(document)
    expect(markdown).not.toContain('We and our partners use cookies')
    expect(markdown).not.toContain('Cookie settings')
  })

  it('drops the products mega-menu', () => {
    const { markdown } = extractPageMarkdown(document)
    for (const [, blurb] of cohere.MEGA_MENU_ITEMS) {
      expect(markdown).not.toContain(blurb)
    }
    expect(markdown).not.toContain('An enterprise-ready AI platform')
  })

  it('drops the footer link columns', () => {
    const { markdown } = extractPageMarkdown(document)
    expect(markdown).not.toContain('Cohere © 2026')
    expect(markdown).not.toContain('Trust Center')
    expect(markdown).not.toContain('Release Notes')
  })

  it('drops the "Read this next" recirculation aside', () => {
    const { markdown } = extractPageMarkdown(document)
    expect(markdown).not.toContain('Read this next')
    expect(markdown).not.toContain('A day in the life of a wealth manager')
  })

  it('reports a real extraction, not a fallback', () => {
    const { usedFallback } = extractPageMarkdown(document)
    expect(usedFallback).toBe(false)
  })
})

describe('the INBOX-1642 page — nothing of the article is lost (AC-3)', () => {
  beforeEach(loadCohere)

  it('keeps the first and last sentences of the body', () => {
    const { markdown } = extractPageMarkdown(document)
    // Rendered markdown escapes * _ [ ] — compare on a de-escaped copy so the assertion
    // is about content survival, not about escaping.
    const plain = markdown.replace(/\\([\\`*_[\]])/g, '$1')
    expect(plain).toContain(cohere.FIRST_SENTENCE)
    expect(plain).toContain(cohere.LAST_SENTENCE)
  })

  it('keeps every feature bullet, as a markdown list', () => {
    const { markdown } = extractPageMarkdown(document)
    for (const [name] of cohere.FEATURES) {
      expect(markdown).toContain(`- **${name}:**`)
    }
  })

  it('keeps the pull quote and the second-level heading', () => {
    const { markdown } = extractPageMarkdown(document)
    expect(markdown).toContain('> ')
    expect(markdown).toContain('## Embed 4 is available today')
  })

  // AC-3 asked for "at least 70%". That number was wrong at filing and this test does
  // NOT assert it. Measured against the real INBOX-1642 row (12,065 chars total, article
  // region chars 2,128–10,769): the article is 71.6% of the capture and ALL chrome —
  // cookie banner, mega-menu, footer, recirculation — is only 28.4%. A 70% reduction is
  // therefore unreachable without deleting 42% of the article, which is the opposite of
  // what this task is for. The criterion is left unticked and carried forward rather
  // than quietly restated at a number the code happens to hit.
  const MEASURED_CHROME_SHARE = 0.284

  it('removes substantially all of the page chrome, at the measured scale', () => {
    const raw = rawPageText(document)
    const { markdown } = extractPageMarkdown(document)
    const reduction = 1 - markdown.length / raw.length
    expect(raw.length).toBeGreaterThan(0)
    // Floor set a little under the measured chrome share to tolerate fixture drift; the
    // chrome-absence assertions above are what actually prove the removal happened.
    expect(reduction).toBeGreaterThanOrEqual(MEASURED_CHROME_SHARE - 0.04)
  })
})

describe('raw escape hatch (AC-5)', () => {
  beforeEach(loadCohere)

  it('{ readability: false } returns the pre-change whole-page text verbatim', () => {
    const { markdown, sourceTag } = extractPageMarkdown(document, { readability: false })
    // Byte-identical to what the old grabText handler produced.
    const legacy = `# ${document.title}\n\n` + (document.body.innerText || document.body.textContent || '')
    expect(markdown).toBe(legacy)
    expect(sourceTag).toBe('RAW')
  })

  it('the raw path still contains the noise the readable path removes', () => {
    // The discriminator: if this passed while the readable path also contained the
    // cookie text, the escape hatch would be indistinguishable from a no-op.
    const { markdown: raw } = extractPageMarkdown(document, { readability: false })
    const { markdown: readable } = extractPageMarkdown(document)
    expect(raw).toContain('We and our partners use cookies')
    expect(readable).not.toContain('We and our partners use cookies')
  })
})

describe('fallback when there is no main content (AC-6)', () => {
  it('returns the whole body for a bare link index rather than nothing', () => {
    document.title = 'Index'
    document.body.innerHTML =
      '<ul>' +
      Array.from({ length: 20 }, (_, i) => `<li><a href="/p${i}">Page ${i}</a></li>`).join('') +
      '</ul>'
    const { markdown, usedFallback } = extractPageMarkdown(document)
    expect(usedFallback).toBe(true)
    expect(markdown).toContain('Page 0')
    expect(markdown.trim()).not.toBe('')
  })

  it('flags the fallback so the caller can say so instead of claiming an extraction', () => {
    document.title = 'Login'
    document.body.innerHTML = '<form><label>User</label><input><button>Go</button></form>'
    expect(extractPageMarkdown(document).usedFallback).toBe(true)
  })

  it('falls back to the uncleaned body when cleaning would empty the page', () => {
    // Every element here reads as chrome; cleaning strips it to nothing, and an empty
    // capture is worse than a noisy one.
    document.title = 'All chrome'
    document.body.innerHTML = '<nav class="navbar"><p>the only text on this page</p></nav>'
    const { markdown } = extractPageMarkdown(document)
    expect(markdown).toContain('the only text on this page')
  })

  it('returns empty without throwing for a document with no body', () => {
    expect(extractPageMarkdown(null).markdown).toBe('')
  })
})

describe('chrome detection', () => {
  const withHtml = (html) => {
    document.body.innerHTML = html
    return document.body.firstElementChild
  }

  it.each([
    ['<nav><a href="/">x</a></nav>', true],
    ['<aside><p>x</p></aside>', true],
    ['<div class="cookie-consent"><p>x</p></div>', true],
    ['<div id="site-footer"><p>x</p></div>', true],
    ['<div role="navigation"><p>x</p></div>', true],
    ['<div aria-hidden="true"><p>x</p></div>', true],
    ['<div hidden><p>x</p></div>', true],
    ['<div style="display:none"><p>x</p></div>', true],
    ['<div class="article-body"><p>x</p></div>', false],
    ['<section><p>x</p></section>', false]
  ])('isChrome(%s) === %s', (html, expected) => {
    expect(isChrome(withHtml(html))).toBe(expected)
  })

  it('does not match a chrome word buried inside a longer word', () => {
    // The trap a bare /nav/ or /banner/ substring falls into. Hyphens are token
    // separators in a class list, so `site-footer` SHOULD match — but `bannerless`
    // and `navigator` are single words that merely start with a chrome word.
    expect(isChrome(withHtml('<div class="bannerless-article"><p>x</p></div>'))).toBe(false)
    expect(isChrome(withHtml('<div class="navigator-panel"><p>x</p></div>'))).toBe(false)
    expect(isChrome(withHtml('<div class="adaptive-layout"><p>x</p></div>'))).toBe(false)
    expect(isChrome(withHtml('<div class="site-footer"><p>x</p></div>'))).toBe(true)
  })

  it('keeps an article <header> but drops a link-heavy site <header>', () => {
    const keep = withHtml('<header class="article-header"><h1>Real title</h1></header>')
    expect(isChrome(keep)).toBe(false)
    const drop = withHtml(
      '<header><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></header>'
    )
    expect(isChrome(drop)).toBe(true)
  })
})

describe('cleanSubtree does not touch the live page', () => {
  it('removes chrome from a clone, leaving the original DOM intact', () => {
    // A content script shares the DOM with the page: mutating in place would visibly
    // dismantle the user's page as a side effect of capturing it.
    document.body.innerHTML = '<div id="root"><nav class="navbar"><a href="/">home</a></nav><p>body text</p></div>'
    const root = document.getElementById('root')
    const cleaned = cleanSubtree(root)
    expect(cleaned.querySelector('nav')).toBeNull()
    expect(root.querySelector('nav')).not.toBeNull()
    expect(document.querySelector('nav')).not.toBeNull()
  })
})

describe('findMain', () => {
  it('picks the article over a longer but link-dense sidebar', () => {
    document.body.innerHTML = `
      <div class="sidebar">${Array.from({ length: 40 }, (_, i) => `<p><a href="/x${i}">Some fairly long link label number ${i}</a></p>`).join('')}</div>
      <div class="post"><p>${'Real prose, with commas, that reads like an article. '.repeat(6)}</p></div>`
    const main = findMain(document)
    expect(main).not.toBeNull()
    expect(main.className).toBe('post')
  })

  it('returns null when nothing reaches the minimum content length', () => {
    document.body.innerHTML = '<p>too short</p>'
    expect(findMain(document)).toBeNull()
  })
})

describe('title selection (live regression)', () => {
  // Found on the live cohere.com/blog/embed-4 capture, NOT by the fixture. The real
  // page keeps its <h1> inside a <header> that cleanSubtree strips as chrome, so the
  // extract has no heading of its own and falls through to document.title — which
  // carries the " | Cohere Blog" site suffix. The original fixture put the h1 inside
  // <article>, never reached that branch, and agreed with itself.
  it('uses the page h1 even when it was stripped as chrome, not document.title', () => {
    document.title = 'Introducing Embed 4: Multimodal search for business | Cohere Blog'
    document.body.innerHTML = `
      <header class="site-header"><nav><a href="/">Home</a></nav>
        <h1>Introducing Embed 4: Multimodal search for business</h1>
      </header>
      <main><article>
        <p>${'Real article prose, with commas, running long enough to score. '.repeat(6)}</p>
      </article></main>`
    const { markdown } = extractPageMarkdown(document)
    expect(markdown.startsWith('# Introducing Embed 4: Multimodal search for business\n')).toBe(true)
    expect(markdown).not.toContain('| Cohere Blog')
  })

  it('still falls back to document.title when the page has no h1 at all', () => {
    document.title = 'Some Page | Site'
    document.body.innerHTML = `<main><p>${'Prose, with commas, long enough to score here. '.repeat(6)}</p></main>`
    expect(extractPageMarkdown(document).markdown.startsWith('# Some Page | Site')).toBe(true)
  })

  it('does not prepend anything when the extract already starts with a heading', () => {
    document.title = 'Ignored | Site'
    document.body.innerHTML = `<main><article><h1>Own Heading</h1>
      <p>${'Prose, with commas, long enough to score here. '.repeat(6)}</p></article></main>`
    const { markdown } = extractPageMarkdown(document)
    expect(markdown.startsWith('# Own Heading')).toBe(true)
    expect(markdown).not.toContain('Ignored')
  })

  it('ignores an empty h1 rather than emitting a bare #', () => {
    document.title = 'Fallback | Site'
    document.body.innerHTML = `<header><h1>   </h1></header>
      <main><p>${'Prose, with commas, long enough to score here. '.repeat(6)}</p></main>`
    expect(extractPageMarkdown(document).markdown.startsWith('# Fallback | Site')).toBe(true)
  })
})
