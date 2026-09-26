---
type: gotcha
title: /workspace-docs serves raster images as bytes, and nothing else binary
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/workspace-docs.ts
    commitSha: d20acf18c3676cd53b41cc9ceff096b2909bca67
  - path: src/adapters/companion/workspace-docs.test.ts
    commitSha: d20acf18c3676cd53b41cc9ceff096b2909bca67
createdAt: 2026-09-26
lastVerifiedAt: 2026-09-26
affectedFeatureId: feature-companion-cockpit
---

## Trigger

A report needs a PDF, an SVG, a font or a video served through `GET /workspace-docs/<ws>/<rel>`. Or someone "simplifies" the binary handling by serving every `BINARY_EXT` file as bytes, or by adding `.svg` to the image list.

## Context

`/workspace-docs` refused every binary with 415 (TASK-1787). TASK-2142 opened ONE family so the companion's Docs pane can inline a report's screenshots: raster images, via `IMAGE_TYPES` / `imageTypeOf` in `workspace-docs.ts`. The companion fetches them through `/api` and splices them into the sandboxed srcdoc frame as `data:` URIs.

## Business rule

- Only `.png .jpg .jpeg .gif .webp .avif .bmp .ico` are served as bytes, **GET only**. A PUT to an image stays 415, so images are readable, not writable.
- The image branch runs **after** the bridge-token check, the workspace lookup and `safeResolve`. It must never move above a guard.
- Response headers: an honest `image/*` content-type, `x-content-type-options: nosniff`, `content-security-policy: sandbox`.
- **SVG is not an image here.** It is text that can carry script, so it stays on the text path like any source file.
- Images over 25 MB answer 413 rather than being read whole into memory.
- Every other binary still answers 415.

## Resolution

To serve another binary family, add it as its own explicit allowlist with its own content-type and tests. Don't widen `imageTypeOf` or drop the `isBinaryPath` refusal. Keep the tests that prove a non-image binary (`.zip`) still gets 415 and that a PUT to a `.png` leaves the file untouched: `workspace-docs.test.ts`, `workspace-docs-html.test.ts` AC-5, `workspace-docs-put.test.ts` AC-7.
