// TASK-1553 — main-content extraction for Grab text. INBOX-1642 is the standing
// evidence: a Cohere blog grab where ~10KB of cookie banner, products mega-menu and
// footer link columns wrapped ~2.5KB of actual article.
//
// Scoring, not a tag whitelist. `<main>`/`<article>` are a hint and get a bonus, but
// plenty of real pages ship the article in an unmarked <div> — a whitelist returns
// nothing on those, which is the one outcome worse than returning noise (AC-6).
//
// The signal that does the work is link density (dom-walk.js): a nav or footer column
// is almost entirely link text, an article paragraph almost none.
//
// Dual-mode (globalThis + module.exports), no import/export — valid MV3 classic script.

;(function (root) {
  const walkApi = root.ChodaDomWalk || (typeof require !== 'undefined' && require('./dom-walk.js'))
  const mdApi = root.ChodaMd || (typeof require !== 'undefined' && require('./md.js'))

  const { textLength, linkDensity } = walkApi

  // Below this, the winning candidate isn't an article — it's a link index, a login
  // screen, an app shell. Fall back to the whole body (AC-6): a noisy capture is
  // recoverable, an empty one silently loses the page.
  const MIN_MAIN_TEXT = 200

  // Only elements this long are scored as content carriers. Short <p>s are real but
  // they attach their score to an ancestor rather than competing as candidates.
  const MIN_PARAGRAPH_TEXT = 25

  const CONTENT_TAGS = new Set(['P', 'PRE', 'BLOCKQUOTE', 'ARTICLE', 'SECTION', 'LI', 'TD'])

  // Structural site chrome. Removed from the extracted subtree unconditionally — none
  // of these ever carries the article itself.
  const CHROME_TAGS = new Set(['NAV', 'ASIDE', 'FORM', 'FIELDSET', 'DIALOG', 'MENU'])

  // Ambiguous: a <header> is either the site masthead or the article's own title block,
  // and a <footer> either the site footer or a byline. Judged by link density instead
  // of removed outright — dropping an article's <header> takes its <h1> with it.
  const AMBIGUOUS_TAGS = new Set(['HEADER', 'FOOTER'])
  const AMBIGUOUS_LINK_DENSITY = 0.5

  const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menubar', 'tablist', 'dialog', 'alertdialog'])

  // Matched against class + id as whole words. Word-bounded deliberately: a bare
  // /nav/ substring also hits "navigation-agnostic-content" and, more painfully,
  // any class containing "banner" like "bannerless-article".
  const CHROME_WORDS =
    /(?:^|[\s_-])(?:cookie|cookies|consent|gdpr|banner|nav|navbar|navigation|menu|megamenu|footer|sidebar|masthead|breadcrumbs?|related|recommended|recirc|newsletter|subscribe|signup|social|share|sharing|promo|advert|advertisement|ads?|popup|modal|overlay|skip-?link|site-?header|site-?footer|toolbar|pagination|comments?|disqus)(?:[\s_-]|$)/i

  function tagOf(el) {
    return ((el && el.tagName) || '').toUpperCase()
  }

  function attrOf(el, name) {
    return (el && el.getAttribute && el.getAttribute(name)) || ''
  }

  /** True when the element is hidden from assistive tech or from rendering outright. */
  function isHidden(el) {
    if (!el || !el.getAttribute) return false
    if (attrOf(el, 'aria-hidden') === 'true') return true
    if (el.hasAttribute && el.hasAttribute('hidden')) return true
    const style = attrOf(el, 'style')
    return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)
  }

  /** Name-based chrome signal: class or id reads as site furniture. */
  function looksLikeChrome(el) {
    if (!el || !el.getAttribute) return false
    const cls = String(attrOf(el, 'class') || '')
    const id = String(attrOf(el, 'id') || '')
    return CHROME_WORDS.test(' ' + cls + ' ') || CHROME_WORDS.test(' ' + id + ' ')
  }

  /** Should this element be stripped from an already-chosen content subtree? */
  function isChrome(el) {
    if (!el) return false
    if (isHidden(el)) return true
    const t = tagOf(el)
    if (CHROME_TAGS.has(t)) return true
    if (CHROME_ROLES.has(attrOf(el, 'role').toLowerCase())) return true
    if (AMBIGUOUS_TAGS.has(t)) {
      return linkDensity(el) > AMBIGUOUS_LINK_DENSITY || looksLikeChrome(el)
    }
    return looksLikeChrome(el)
  }

  // ---- scoring ---------------------------------------------------------------

  const TAG_BONUS = { ARTICLE: 1.5, MAIN: 1.45, SECTION: 1.1 }

  /**
   * Readability-style bottom-up scoring: each content-bearing element contributes to
   * its ancestors, so the container holding the most prose wins without anyone naming
   * it. Contribution decays with distance — a great-grandparent that also wraps the
   * nav should not out-score the article div itself.
   */
  function scoreCandidates(scope) {
    const scores = new Map()
    const add = (el, n) => {
      if (!el || el.nodeType !== 1) return
      scores.set(el, (scores.get(el) || 0) + n)
    }

    // Collected through the shared walk rather than querySelectorAll so this module has
    // exactly one way of crossing the DOM (AC-1). It also inherits the walk's skip set,
    // which a selector query would not.
    const carriers = []
    walkApi.walk(
      scope,
      ({ el, tag }) => {
        if (CONTENT_TAGS.has(tag)) carriers.push(el)
      },
      { includeRoot: false }
    )

    for (const el of carriers) {
      const len = textLength(el)
      if (len < MIN_PARAGRAPH_TEXT) continue
      // Commas approximate sentence complexity — prose has them, link lists don't.
      const commas = (el.textContent.match(/[,،、]/g) || []).length
      const base = 1 + commas + Math.min(Math.floor(len / 100), 3)

      add(el.parentElement, base)
      if (el.parentElement) add(el.parentElement.parentElement, base / 2)
      if (el.parentElement && el.parentElement.parentElement) {
        add(el.parentElement.parentElement.parentElement, base / 3)
      }
    }

    let best = null
    let bestScore = 0
    for (const [el, raw] of scores) {
      // Link density is the discriminator, applied last so it can veto a high raw score:
      // a footer full of short link paragraphs accumulates real points otherwise.
      let score = raw * (1 - linkDensity(el)) * (TAG_BONUS[tagOf(el)] || 1)
      if (isChrome(el)) score *= 0.2
      if (score > bestScore) {
        bestScore = score
        best = el
      }
    }
    return { best, score: bestScore, scores }
  }

  /**
   * Pick the element holding the page's main content, or null when nothing qualifies.
   * Never returns a subtree shorter than MIN_MAIN_TEXT — the caller falls back instead.
   */
  function findMain(doc) {
    const body = doc && doc.body
    if (!body) return null
    const { best } = scoreCandidates(body)
    if (!best) return null
    if (textLength(best) < MIN_MAIN_TEXT) return null
    return best
  }

  /**
   * Strip site chrome from a COPY of the chosen subtree.
   *
   * The clone is not an optimization — a content script shares the live DOM with the
   * page, so removing nodes from `el` directly would visibly dismantle the user's page
   * as a side effect of capturing it.
   */
  function cleanSubtree(el) {
    if (!el || !el.cloneNode) return el
    const clone = el.cloneNode(true)
    // Collect first, remove after: mutating during a walk invalidates the traversal.
    const doomed = []
    walkApi.walk(clone, ({ el: node }) => {
      if (node === clone) return
      if (isChrome(node)) {
        doomed.push(node)
        return false // its subtree goes with it; no need to descend
      }
    })
    for (const node of doomed) {
      if (node.parentNode) node.parentNode.removeChild(node)
    }
    return clone
  }

  // ---- entry points ----------------------------------------------------------

  /**
   * The pre-TASK-1553 behavior, preserved exactly (AC-5): document title as an H1 plus
   * body.innerText. The textContent fallback is inert in a real browser — innerText is
   * always defined there — and only exists so the escape hatch is testable.
   */
  function rawPageText(doc) {
    const title = doc && doc.title ? `# ${doc.title}\n\n` : ''
    const body = doc && doc.body ? doc.body.innerText || doc.body.textContent || '' : ''
    return title + body
  }

  /**
   * Grab text's extraction. Returns markdown.
   *
   * opts.readability === false → the raw whole-page path, unchanged (AC-5).
   *
   * Returns { markdown, usedFallback, sourceTag } so the caller can tell a clean
   * extraction from a full-body fallback. Reporting "extracted" for what was really a
   * fallback is the kind of quiet overclaim TASK-1549/1551 were about.
   */
  function extractPageMarkdown(doc, opts) {
    const options = opts || {}
    if (options.readability === false) {
      return { markdown: rawPageText(doc), usedFallback: false, sourceTag: 'RAW' }
    }
    if (!doc || !doc.body) return { markdown: '', usedFallback: true, sourceTag: '' }

    const main = findMain(doc)
    const usedFallback = !main
    const scope = main || doc.body
    const cleaned = cleanSubtree(scope)
    let markdown = mdApi.toMarkdown(cleaned)

    // A fallback that cleaned itself down to nothing is worse than the noise it removed
    // — take the uncleaned body rather than hand back an empty capture (AC-6).
    if (!markdown.trim()) markdown = mdApi.toMarkdown(scope)

    // Prefer the article's own H1; it is the real title and it lacks the " | Site Name"
    // suffix document.title carries. Only prepend when the extract has no heading.
    if (doc.title && !/^#\s/.test(markdown)) {
      markdown = `# ${doc.title}\n\n${markdown}`
    }

    return { markdown: markdown.trim(), usedFallback, sourceTag: tagOf(scope) }
  }

  const api = {
    extractPageMarkdown,
    rawPageText,
    findMain,
    cleanSubtree,
    scoreCandidates,
    isChrome,
    looksLikeChrome,
    isHidden,
    MIN_MAIN_TEXT,
    CHROME_WORDS
  }
  root.ChodaReadability = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
