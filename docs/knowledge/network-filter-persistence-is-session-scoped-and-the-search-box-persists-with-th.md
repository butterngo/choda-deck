---
type: decision
title: Network filter persistence is session-scoped, and the search box persists with the chips
projectId: choda-deck
scope: project
refs:
  - path: extension/lib/reqfilter.js
    commitSha: 8bac9bb175e4b75f222076128c151545666d4392
  - path: extension/popup.js
    commitSha: 8bac9bb175e4b75f222076128c151545666d4392
createdAt: 2026-07-30
lastVerifiedAt: 2026-07-30
---

## Decision

The Choda Capture Network panel persists its filter state — type chip, method, status class,
**and the free-text search** — across a side-panel close/reopen, via
`chrome.storage.session`. Ratified by Butter 2026-07-30; shipped in PR #225 (`8bac9bb`).

Two sub-decisions, both deliberate:

## 1. `chrome.storage.session`, not `.local`

A filter set minutes ago should still be there when the panel reopens — the side panel is
closed and reopened constantly while working a page, and losing the filter every time was the
original complaint. But a filter restored from *last week* silently hiding rows is a trap:
you would open the panel on a fresh investigation, see an incomplete list, and have no cue
that a stale choice was responsible.

Session scope resolves this without a heuristic. It survives every panel reopen and every tab
switch, and clears on browser restart — which is about as long as the intent behind a filter
lasts. No expiry logic, no "clear filters" affordance needed for the common case.

The panel's other persisted state stays on `.local` deliberately: the bridge token and
`projectByDomain` (which project a host maps to) are configuration, not transient intent, and
must survive a restart.

## 2. The search query persists alongside the chips

Only the chips were requested. Persisting the query too was a judgment call, taken because
**half-persisting a composite filter is worse than persisting all of it**: you would reopen
with `API` + `4xx` visibly lit and a search box that *looks* empty but is in fact still
narrowing the list, with no way to see why rows are missing. Four filters compose into one
result; splitting their lifetimes makes the result unexplainable.

This is only acceptable because of a prior fix in the same area (PR #224): the empty list now
reads *"no requests match the current filters"* instead of *"no requests seen — reload the
page"*. A stale filter is therefore self-describing. **If that message ever regresses to
blaming the page, this decision must be revisited** — the two are coupled, and a silent
narrowing filter with a misleading empty state is exactly the class of bug #224 fixed
(chip counts that contradicted the list).

## Consequences

- Restoring happens in `init()` **before** the first `renderChips()` / `renderReqList()`,
  otherwise the controls and the state disagree for a frame.
- Storage is untrusted input, so `sanitizeFilterState()` (`extension/lib/reqfilter.js`)
  coerces anything unusable to defaults: unknown chip → `all`, bad status class → `all`,
  non-alphabetic method → `all`, query capped at 200 chars, non-object → full defaults. A
  filter shape written by an older version must never leave the panel stuck showing nothing.
- `FILTERS` in `popup.js` reads `ChodaReqFilter.FILTER_TYPES` so the rendered chips and the
  validator cannot drift — adding a chip in one place without the other would make it
  un-persistable.
- Not covered by tests: the actual `chrome.storage.session` round-trip on a real panel
  close/reopen. The validator is unit-tested; the side panel is not automatable. Verify by
  hand alongside TASK-1547.

## Related

- PR #225 (`8bac9bb`) — implementation; PR #224 (`59d8307`) — the empty-state message this
  depends on
- `an-extension-lib-must-be-listed-before-its-consumer-in-manifest-content-scripts-` —
  `lib/reqfilter.js` must load before `popup.js`, which now reads off it at parse time
