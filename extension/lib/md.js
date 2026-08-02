// TASK-1553 — DOM → markdown serializer. The half of the Grab-text fix that is about
// STRUCTURE rather than noise: innerText flattens a <ul> into indistinguishable lines
// and drops every link target, so even a perfectly de-noised capture arrived shapeless.
//
// Deliberately not a general HTML→MD converter. It covers what a captured article
// actually contains — headings, paragraphs, lists, tables, code, quotes, links,
// emphasis, images-by-reference — and degrades to plain text for anything else rather
// than emitting half-formed markup.
//
// Dual-mode (globalThis + module.exports), no import/export — valid MV3 classic script.

;(function (root) {
  const walkApi = root.ChodaDomWalk || (typeof require !== 'undefined' && require('./dom-walk.js'))

  const ELEMENT_NODE = 1
  const TEXT_NODE = 3

  const HEADINGS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 }

  // Elements that start their own block. Anything not listed is treated as inline and
  // folded into the surrounding paragraph.
  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL',
    'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
    'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
    'SECTION', 'TABLE', 'UL'
  ])

  function tag(node) {
    return ((node && node.tagName) || '').toUpperCase()
  }

  function isBlock(node) {
    return node && node.nodeType === ELEMENT_NODE && BLOCK_TAGS.has(tag(node))
  }

  function collapse(s) {
    return String(s || '').replace(/\s+/g, ' ')
  }

  // Escape only the characters that would change the MEANING of the surrounding line.
  // Aggressive escaping (every . and +) is what makes naive converters emit unreadable
  // backslash soup for ordinary prose.
  function escapeInline(s) {
    return s.replace(/([\\`*_[\]])/g, '\\$1')
  }

  function attr(el, name) {
    return (el.getAttribute && el.getAttribute(name)) || ''
  }

  // ---- inline ---------------------------------------------------------------

  function renderInline(node) {
    if (!node) return ''
    if (node.nodeType === TEXT_NODE) return escapeInline(collapse(node.nodeValue))
    if (node.nodeType !== ELEMENT_NODE) return ''
    if (walkApi && walkApi.isSkippedTag(node)) return ''

    const t = tag(node)
    if (t === 'BR') return '\n'
    if (t === 'IMG') {
      const alt = collapse(attr(node, 'alt')).trim()
      const src = attr(node, 'src')
      return src ? `![${escapeInline(alt)}](${src})` : ''
    }

    const inner = childrenInline(node)

    if (t === 'A') {
      const href = attr(node, 'href')
      const text = inner.trim()
      if (!text) return ''
      // A bare anchor (#tab-2, javascript:void) is a control, not a reference — keep its
      // words, drop the target rather than emitting a link that goes nowhere.
      if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) return text
      return `[${text}](${href})`
    }
    if (t === 'CODE' || t === 'KBD' || t === 'SAMP') {
      return wrap(inner, '`', '`', (s) => s.replace(/\\([\\`*_[\]])/g, '$1'))
    }
    if (t === 'STRONG' || t === 'B') return wrap(inner, '**', '**')
    if (t === 'EM' || t === 'I') return wrap(inner, '*', '*')
    if (t === 'DEL' || t === 'S') return wrap(inner, '~~', '~~')
    return inner
  }

  /**
   * Wrap inline content in markers, keeping any boundary whitespace OUTSIDE them.
   *
   * `<strong>Key Contributors: </strong>Carlos` carries its separating space inside the
   * tag. Trimming before emitting the markers destroyed it and produced
   * `**Key Contributors:**Carlos` — words fused together, found on the live cohere.com
   * capture. Markdown also will not parse `** bold **` with inner padding, so the space
   * has to move out rather than simply be kept.
   */
  function wrap(inner, open, close, transform) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)
    if (!m) return ''
    // Whitespace-only content emits the whitespace, not nothing: `a<b>   </b>c` still
    // separates the two words, and dropping it would fuse them.
    if (!m[2]) return m[1] ? ' ' : ''
    const core = transform ? transform(m[2]) : m[2]
    return `${m[1]}${open}${core}${close}${m[3]}`
  }

  function childrenInline(el) {
    let out = ''
    for (const child of Array.from(el.childNodes || [])) out += renderInline(child)
    return out
  }

  // ---- blocks ---------------------------------------------------------------

  function renderList(el, depth) {
    const ordered = tag(el) === 'OL'
    const startAttr = parseInt(attr(el, 'start'), 10)
    let i = Number.isFinite(startAttr) ? startAttr : 1
    const pad = '  '.repeat(depth)
    const lines = []
    for (const li of Array.from(el.children || [])) {
      if (tag(li) !== 'LI') continue
      const marker = ordered ? `${i++}. ` : '- '
      // A nested list is a child BLOCK of the <li>. Depth is NOT incremented here: the
      // continuation-line indent below already supplies one level, and doing both
      // indents every nested list twice.
      const body = renderChildren(li, depth).join('\n\n').trim()
      if (!body) continue
      const [first, ...rest] = body.split('\n')
      lines.push(pad + marker + first)
      for (const line of rest) lines.push(line ? pad + '  ' + line : '')
    }
    return lines.join('\n')
  }

  function renderTable(el) {
    const rows = Array.from((el.querySelectorAll && el.querySelectorAll('tr')) || [])
    if (!rows.length) return ''
    const cells = (tr) =>
      Array.from(tr.children || [])
        .filter((c) => tag(c) === 'TD' || tag(c) === 'TH')
        .map((c) => childrenInline(c).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim())

    const head = cells(rows[0])
    if (!head.length) return ''
    const out = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`]
    for (const tr of rows.slice(1)) {
      const c = cells(tr)
      if (!c.length) continue
      while (c.length < head.length) c.push('')
      out.push(`| ${c.slice(0, head.length).join(' | ')} |`)
    }
    return out.join('\n')
  }

  function renderPre(el) {
    const codeEl = el.querySelector && el.querySelector('code')
    const source = codeEl || el
    const text = (source.textContent || '').replace(/\s+$/, '')
    if (!text.trim()) return ''
    // Language from the conventional `language-x` / `lang-x` class hljs and Prism emit.
    const cls = attr(source, 'class') || attr(el, 'class')
    const m = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(cls)
    const lang = m ? m[1] : ''
    // A fence has to outrun any backtick run inside the code, or the block ends early.
    const longest = (text.match(/`+/g) || []).reduce((a, b) => Math.max(a, b.length), 0)
    const fence = '`'.repeat(Math.max(3, longest + 1))
    return `${fence}${lang}\n${text}\n${fence}`
  }

  function renderBlock(el, depth) {
    const t = tag(el)
    if (walkApi && walkApi.isSkippedTag(el)) return ''

    if (HEADINGS[t]) {
      const text = childrenInline(el).replace(/\n/g, ' ').trim()
      return text ? `${'#'.repeat(HEADINGS[t])} ${text}` : ''
    }
    if (t === 'HR') return '---'
    if (t === 'PRE') return renderPre(el)
    if (t === 'UL' || t === 'OL') return renderList(el, depth)
    if (t === 'TABLE') return renderTable(el)
    if (t === 'BLOCKQUOTE') {
      const body = renderChildren(el, depth).join('\n\n').trim()
      if (!body) return ''
      return body
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n')
    }
    if (t === 'P') {
      const text = childrenInline(el).replace(/[ \t]+\n/g, '\n').trim()
      return text
    }
    // Generic container (div, section, li, figure, …): recurse.
    return renderChildren(el, depth).join('\n\n')
  }

  /**
   * Split an element's children into blocks. Consecutive inline children are gathered
   * into one implicit paragraph — without that, `<div>some <b>bold</b> text</div>`
   * fragments into three separate blocks and the sentence comes apart.
   */
  function renderChildren(el, depth) {
    const blocks = []
    let pending = ''

    const flush = () => {
      const text = pending.replace(/[ \t]+\n/g, '\n').trim()
      if (text) blocks.push(text)
      pending = ''
    }

    for (const child of Array.from(el.childNodes || [])) {
      if (isBlock(child)) {
        flush()
        const rendered = renderBlock(child, depth)
        if (rendered && rendered.trim()) blocks.push(rendered)
      } else {
        pending += renderInline(child)
      }
    }
    flush()
    return blocks
  }

  /**
   * Serialize an element subtree to markdown. Blank lines are normalized to at most
   * one, so a page built from deeply nested empty wrappers doesn't arrive as a column
   * of whitespace.
   */
  function toMarkdown(el, opts) {
    if (!el) return ''
    const depth = (opts && opts.depth) || 0
    const body = isBlock(el) && tag(el) !== 'DIV' ? renderBlock(el, depth) : renderChildren(el, depth).join('\n\n')
    return body
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  const api = { toMarkdown, renderInline, renderBlock, escapeInline, BLOCK_TAGS, isBlock }
  root.ChodaMd = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
