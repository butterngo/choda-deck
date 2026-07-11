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

## Notes / limits (v1)

- Screenshot = visible viewport (no region-drag crop yet).
- Network-header capture not wired into the UI yet (bridge supports it).
- `chrome://` / `edge://` / PDF pages can't be read — type text or screenshot instead.
- Pick a real project in the dropdown; an unknown projectId currently errors server-side.
