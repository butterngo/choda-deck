---
type: learning
title: URL deny-lists match by substring — use vendor-specific tokens only, never a generic word
projectId: choda-deck
scope: project
refs:
  - path: extension/lib/noise-filter.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/lib/noise-filter.test.js
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
  - path: extension/README.md
    commitSha: 3b4684a0f8e76b145ff201c8c150c5cae4027cad
createdAt: 2026-07-30
lastVerifiedAt: 2026-07-30
---

## Trigger

A business endpoint silently vanishes from a capture. Nothing errors, nothing warns — the row
simply isn't there, because a deny-list entry matched a substring of its URL that the author
never intended to cover.

## Context

`DEFAULT_EXCLUDE_PATTERNS` in `extension/lib/noise-filter.js` drops telemetry beacons
(Application Insights, `monitor.azure.com`, Google Analytics, Sentry, Datadog-class) before
they ever reach a recording. Matching is **substring containment against the URL**, which is
cheap and dependency-free but has no notion of word boundaries, path segments, or hostname
structure.

That makes a generic token catastrophic. `'track'` would drop `/api/v2/track-order`.
`'log'` would drop `/api/login` and `/api/catalog`. The loss is invisible at capture time and
looks like a capture bug much later, from a recording where the endpoint is merely absent.

## Business rule

**Deny-list entries must be vendor-specific and as long as possible** — prefer a full host
(`google-analytics.com`, `dc.services.visualstudio.com`) over a path fragment, and never a
bare English word that could appear inside a legitimate route.

The asymmetry that justifies this: a missed telemetry beacon costs one noisy row in a
recording, while an over-broad pattern costs a *silently absent* business call — the thing the
recording exists to capture. Bias every entry toward under-matching.

Pin each new entry with a test that a plausible business URL containing the same word
**survives**. `/api/v2/track-order` is the standing case for `'track'`.

## Resolution

Add vendor hosts, not words, and extend the list only as real recordings surface real vendors.
Documented for extension in `extension/README.md` per TASK-1423 AC-2.

## Known limitation

The list is calibrated against a **single** recording (INBOX-1172), so it is tuned to a sample
of one — Azure-instrumented. Sites using other vendors will surface unfiltered beacons until
their hosts are added. That is the intended failure direction (noise, not loss).

## Related

- `redact-persisted-request-headers-by-allow-list-not-deny-list` (automation-rule /
  workflow-engine) reaches the opposite conclusion for a different layer, and the contrast is
  the useful part: **secrets** need an allow-list, because an unknown header is guilty until
  proven safe. **Noise** needs a deny-list, because an unknown URL is innocent until proven
  worthless. Inverting either one loses data.
