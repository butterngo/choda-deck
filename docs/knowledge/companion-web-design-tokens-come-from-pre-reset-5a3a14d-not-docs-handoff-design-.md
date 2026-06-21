---
type: gotcha
title: Companion web design tokens come from pre-reset 5a3a14d, not docs/handoff-design (wiped)
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-21
lastVerifiedAt: 2026-06-21
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** looking for the companion's design system, or wondering why `packages/web` has no queue/conversation views.

**Context:** the `choda-deck-companion` repo was reset to a clean slate (commit `8b80fd1`) because the prior web+mobile UI was built against the wrong requirement. `docs/handoff-design/` (the original token source) was wiped in that reset.

**Business rule:** the v2 design tokens are NOT regenerated and have no `docs/handoff-design` dependency — they were recovered verbatim from the pre-reset commit `5a3a14d` (`packages/web/src/index.css` + `tailwind.config.js`: palette, Tabler webfont icons, `.live-dot`/`.spin`, prose, blue-600 focus ring).

**Resolution:** when touching styling, edit the recovered `index.css`/tailwind config — don't look for handoff-design. The old `views/` (Queue, Conversation, Inbox, Settings) were intentionally dropped as the wrong requirement; the new app is sync/workflow/knowledge pillars only.
