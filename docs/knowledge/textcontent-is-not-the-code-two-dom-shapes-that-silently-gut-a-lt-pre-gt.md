---
type: learning
title: "textContent is not the code — two DOM shapes that silently gut a &lt;pre&gt;"
projectId: choda-deck
scope: project
refs:
  - path: extension/lib/md.js
    commitSha: c936434814688c3e45d842a1dc4bd2e9f353b367
  - path: extension/lib/md.test.js
    commitSha: c936434814688c3e45d842a1dc4bd2e9f353b367
createdAt: 2026-08-04
lastVerifiedAt: 2026-08-04
---

## Trigger

Grab text on a documentation page and the code blocks come back wrong — either collapsed to a
single unreadable line, or reduced to a fragment while the surrounding prose still says
"Some examples:" and then shows nothing. Unit tests are green. Both were found live on
2026-08-04 (TASK-1559) and neither was caught by the 38-test `md.test.js` suite.

## Context

`renderPre()` in `extension/lib/md.js` turns a `<pre>` into a fenced markdown block. It made
two reasonable-looking assumptions about DOM shape, and real documentation sites break both.

**1. `<code>` is not necessarily the block wrapper.**

The conventional shape is `<pre><code>…</code></pre>`, so the code did
`el.querySelector('code')` and used **only that element's text**. PostgreSQL's docs put inline
result annotations *inside* the `<pre>`:

```html
<pre class="screen">SELECT SUBSTRING('XY1234Z', 'Y*([0-9]{1,3})');
<em class="lineannotation">Result: </em><code class="computeroutput">123</code>
SELECT SUBSTRING('XY1234Z', 'Y*?([0-9]{1,3})');
<em class="lineannotation">Result: </em><code class="computeroutput">1</code></pre>
```

`querySelector('code')` returns the first **inline annotation**. A 117-character example
rendered as `123` — 114 characters dropped, no marker, prose left dangling.

**2. `textContent` does not carry line structure.**

Syntax highlighters (Shiki, Prism, hljs) emit one element per line and **no literal newline
text nodes** — the breaks come from CSS. Verified on tailwindcss.com: the `<pre>` contains
**zero** `\n` characters. A 12-line HTML example arrived as one string.

This one is subtle because the output is *faithful to `textContent`*. Nothing was dropped.
It is still wrong, because faithful to `textContent` is not the same as faithful to the code.

## Business rule

- Unwrap a `<code>` child only when it **wraps the whole `<pre>`** — sole element child. An
  inline `<code>` is content, not a container.
- When `textContent` has no newline but the block has multiple element children, rebuild the
  lines from those children. Guard on the no-newline condition so an ordinary `<pre>` is
  untouched and a single-line block never gains invented breaks.

## Resolution

Fixed in `c936434` (PR #238). `preText()` handles the line rebuild, descending through
single-child wrappers (`<pre><code><code>…`) to the element that actually holds the per-line
children.

The regression tests replicate the **live DOM shape**, not an idealised one — which is exactly
why the originals passed. The line-structure test asserts `pre.textContent` contains no `\n`
as an explicit **precondition**: without it the fixture could pass for the wrong reason and
prove nothing.

## Not a bug — recorded so it is not re-investigated

MDN's JavaScript reference pages have **zero `<pre>` elements in the DOM**. The example code
never renders (checked before and after scrolling; `Math.sqrt` appears nowhere in
`document.body.textContent`). A grab there legitimately returns prose with no code. Nothing was
dropped, because there was nothing to drop — and this looked identical to defect 1 from the
output alone. MDN is therefore a **bad choice for verifying code-block extraction**; use
postgresql.org's docs, which server-render 26 `<pre>` and 12 `<table>` on a single page.
