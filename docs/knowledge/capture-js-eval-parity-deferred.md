---
type: evaluation
title: JS-evaluation capture parity — DEFER, claude-in-chrome is the fallback
projectId: choda-deck
scope: project
refs:
  - path: extension/inject.js
    commitSha: 8dcacc98e9b86fc4bf4c0444b7361655f804f5c7
  - path: src/adapters/companion/capture-dispatcher.ts
    commitSha: 8dcacc98e9b86fc4bf4c0444b7361655f804f5c7
createdAt: 2026-07-23
lastVerifiedAt: 2026-07-23
---

## Question (TASK-1463)

claude-in-chrome's `javascript_tool` can read arbitrary computed values from a page
(a JS variable, a store's state, a computed style). Choda Capture has no equivalent.
Should the extension gain a JS-evaluation capture, and if so in what constrained form?

## Recommendation: DEFER (do not build now)

Reject the general form; do not build a constrained form yet either. Document
claude-in-chrome's `javascript_tool` as the designated fallback for the rare case
where a computed value is genuinely needed.

## Rationale

1. **Different risk class from the rest of the extension.** Everything Choda Capture
   does today is *passive recording* — it observes fetch/XHR, DOM events, console,
   snapshots — and redacts at capture time in-page (TASK-1411, redact.js). An
   arbitrary user-entered JS-eval feature is *active execution*: it runs attacker-
   influenceable strings in the page's MAIN world, which is a materially larger
   exfiltration/XSS surface. The whole capture pipeline is deliberately local-only
   for exactly this reason (see gotcha: secret-carrying-capture-kinds-are-local-only,
   and the `guardLocalOnly` rationale in capture-dispatcher.ts). Adding an eval path
   cuts against that grain.

2. **The need is unproven.** The concrete use cases driving the parity epic (TASK-1460)
   are: reproduce a failing flow, see the API behind a screen, read the console error.
   All three are now covered — network capture (TASK-1424), console capture (TASK-1461),
   discovery timeline. No real request has surfaced for "read a computed JS value";
   it was included in the parity list for completeness, not from felt pain (cf.
   feedback: confirm pain first before building framework-driven features).

3. **A cheap, safe fallback already exists.** When a computed value truly matters,
   claude-in-chrome's `javascript_tool` handles it — Claude-driven, one-off, not a
   standing capability baked into an extension the user runs on every page. That is
   the right home for an eval: transient and operator-gated, not persistent.

## If it ever becomes needed — the only shapes worth revisiting

Do NOT ship free-form `eval(userString)`. The only forms that would be reconsidered:
- Capture a **chosen element's** attributes / computed style (structured, no free JS).
- Read a **JSON path off a named global** the user types (e.g. `window.__STATE__.user`)
  — still constrained to property access, no call expressions.

Either would need its own security review and a redaction pass, and should be a fresh
task gated on a real, stated use case — not built speculatively.

## Outcome

TASK-1460 parity table: JS-evaluation is intentionally **out of scope** for Choda
Capture; claude-in-chrome `javascript_tool` is the fallback. See
[[claude-in-chrome-browser-tools]].
