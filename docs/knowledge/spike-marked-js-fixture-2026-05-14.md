---
title: Spike Gate A — marked.js fixture render (Phase 2 companion)
date: 2026-05-14
status: complete
linked_task: TASK-737
related_adrs: [companion-ui-system]
---

# Spike: marked.js render `report.md` fixture

## TL;DR

**PASS** — marked@12.0.1 from cdnjs renders the TASK-726 `report.md` output (queue-1778471338165-1qtq) cleanly. All 4 auto-verify checks green. Use this version pinned for Phase 2 viewer (TASK-739).

## Configuration

| Item | Value |
|---|---|
| Library | `marked@12.0.1` |
| CDN | `https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.1/marked.min.js` |
| Fixture | `C:\dev\choda-deck\data\artifacts\queue-1778471338165-1qtq\report.md` |
| Render call | `marked.parse(document.getElementById('md').textContent)` |
| Spike file | `C:\dev\choda-deck-companion\packages\server\__spikes__\marked-fixture\index.html` |

Markdown content was inlined into `<script type="text/markdown" id="md">…</script>` so the spike runs from `file://` with no CORS / no server.

## Auto-verify results (4/4 PASS)

1. **Tables render** — `<table>` count ≥ 1. Fixture has 3 tables (metadata, files changed, AC verification), all rendered as native `<table>` elements.
2. **Code blocks render** — `<pre><code>` count ≥ 1. The `Artifacts` tree listing renders as `<pre><code>`.
3. **Tree listing characters preserved** — `├──` / `└──` characters present inside `<pre>`. No mangling.
4. **Heading hierarchy** — `<h1>`, `<h2>`, `<h3>` all present, levels respected, no skipping.

## Edge cases / notes

- `prose prose-sm dark:prose-invert` (Tailwind typography) not applied in spike; impl in TASK-739 will add it.
- No syntax highlighting attempted (deferred Phase 3+ per UI.md § Detail markdown render).
- Sanitization via DOMPurify is **not** exercised by this spike — Gate A only verifies render fidelity. The XSS test fixture lives in TASK-739 acceptance (UI.md § Detail markdown render — Gate A AC).

## Recommendation

**Use `marked@12.0.1`** in Phase 2 impl. Pin via CDN URL above. Pair with DOMPurify (also CDN) per UI.md sanitize spec when implementing TASK-739.

## Related

- TASK-737 — this spike
- TASK-739 — Phase 2 viewer (unblocked by this)
- TASK-726 — fixture source (DONE)
- `companion-ui-system.md` § Phase 2 Gates + § Detail markdown render
