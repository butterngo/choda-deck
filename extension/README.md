# Choda Capture — browser extension (TASK-1333)

One-click capture of page **text** or a **screenshot** straight into choda-deck
(inbox / task / conversation / knowledge), so it's reachable from Claude Code via the
`choda-tasks` MCP — no copy-paste, no "save the file and read it". Talks to the local
companion capture bridge (`POST /capture`, ADR-036). Works in Chrome and Edge.

## Setup

1. **Run the bridge** (the companion server) pointed at your real data dir:
   ```powershell
   pnpm run build:companion
   $env:CHODA_DATA_DIR = "C:\dev\choda-deck\data"
   $env:CHODA_CONTENT_ROOT = "C:\Users\hngo1_mantu\vault"
   node dist/companion-server.cjs      # → listening on http://127.0.0.1:7338
   ```
2. **Load the extension** — `chrome://extensions` (or `edge://extensions`) → enable
   **Developer mode** → **Load unpacked** → pick this `extension/` folder.
3. **Pair the token** — click the extension → it says "no token"; open its **Options**,
   paste the contents of `data/bridge-token.txt` (printed on server boot), Save.

## Use

- Select text on any page → click the extension → it's prefilled → pick project +
  destination → **Capture →**. Defaults to **inbox**.
- Switch to **Screenshot** → **Grab visible tab** → destination is limited to
  conversation/knowledge (secret-safe, stays local). The PNG lands in
  `data/artifacts/captures/` and the entry references it.

## Discovery recording — noise filter (TASK-1423)

A recording captures every fetch/XHR the page makes, which on a real app is mostly
noise. Two gates run in `lib/noise-filter.js` before an `apicall` event is emitted:

- **Telemetry deny-list** — `DEFAULT_EXCLUDE_PATTERNS` (Application Insights,
  `*.monitor.azure.com`, GA/GTM, Sentry, Datadog, Segment, Hotjar, …). Matched as
  case-insensitive substrings of the full URL. **To add a vendor, append a pattern
  to that const** — keep it vendor-specific (`google-analytics.com`), never a bare
  word like `track` or `api`, which would eat real endpoints.
- **Asset fan-out collapse** — repeats of the same `METHOD + origin + pathname`
  (query ignored) fold into the first event, which gains `collapsed: <n>` and up to
  5 `collapsedSamples` URLs. So 10× `GetEmployeeThumbnail?Id=1..10` becomes one
  event saying "this fired 10 times, here are 5 of the ids".

Measured on the INBOX-1172 recording: 20 raw apicalls → 8 events, with no business
endpoint lost. Both gates are per-recorder options — `createRecorder({ excludePatterns, collapse: false })`
opts out if you ever need the raw stream.

## Grab text — main-content extraction (TASK-1553)

**Grab page text** no longer takes the whole body. It scores the page for its main
content, strips the site chrome, and serializes what's left to markdown.

- **What gets dropped** — `nav` / `aside` / `form`, anything `aria-hidden` or
  `display:none`, elements whose class or id reads as chrome (`cookie-consent`,
  `megamenu`, `site-footer`, `newsletter`, `related`, …), and a `header`/`footer`
  only when it is link-heavy — an article's own `<header>` keeps its `<h1>`.
  Chrome words are matched as **whole hyphen-separated tokens**, so `site-footer`
  matches but `bannerless-article` does not.
- **What you gain** — real markdown: headings at the right depth, `<ul>`/`<ol>` as
  lists, `<table>` as a pipe table, `<pre><code>` fenced with its language, and
  `<a href>` as `[text](url)`. innerText discarded all of that.
- **The scorer can be wrong.** Tick **raw page** next to the button for the old
  whole-page behavior — byte-identical to pre-TASK-1553 output.
- **No main content found** → it grabs the whole body and *says so* in the status
  line ("Grabbed whole page — no main content found"). An empty capture is never
  returned; a page that is genuinely a link index still comes back in full.

Measured on the INBOX-1642 capture (cohere.com/blog/embed-4): the cookie banner,
products mega-menu, recirculation block and footer link columns all disappear, and
every paragraph of the article survives. Reduction is ~30%, not the ~70% originally
guessed when the task was filed — on that page the article is 71.6% of the capture
and *all* chrome is only 28.4%. See `docs/reports/task-1553-ac-verification.md`.

The three libs (`lib/dom-walk.js`, `lib/md.js`, `lib/readability.js`) are injected on
demand by the panel, not registered in `manifest.json` — they only matter at the moment
of a grab, and on-demand injection also survives an extension reload, which does not
re-inject manifest content scripts into already-open tabs.

## Notes / limits (v1)

- Screenshot = visible viewport (no region-drag crop yet).
- Network-header capture not wired into the UI yet (bridge supports it).
- `chrome://` / `edge://` / PDF pages can't be read — type text or screenshot instead.
- Pick a real project in the dropdown; an unknown projectId is rejected with a clean
  `404 project "<id>" does not exist` (TASK-1425).
