---
task: TASK-2594
goal: TASK-2585
generatedAt: 2026-10-21
source: buildRuns (repo code at a275eb9+) on a copy of data/database/choda-deck.db, 2026-10-21 08:35Z, plus TASK-2586..2588
status: approved — Butter, 2026-10-21 ~08:37Z in chat ("Duyệt như vậy"); the 🟡 notice INBOX-2281 was dismissed on the decide screen at 08:41Z
---

# Backfill: which feature each goal on the Runs screen realizes

Decision (Butter, 2026-10-21): every goal is tied to exactly one feature; the goals already on the Runs
screen are linked once from this table. "NEW" rows create a feature (type `feature`, plain-words
`## Why this exists`, no code or paths — the CEO view reads it) and then link it with `feature_link`.

## Proposed table

| # | Goal | Project | Title | Feature |
|---|---|---|---|---|
| 1 | TASK-2585 | choda-deck | Runs: every run's goal is tied to a feature, shown on the run card | NEW `companion-runs` |
| 2 | TASK-2586 | choda-deck | Each task gets a sequence diagram and its acceptance criteria are paired with the tests that ran | NEW `companion-runs` |
| 3 | TASK-2587 | choda-deck | Each run ends with a test report, including a smoke test on QC or locally | NEW `companion-runs` |
| 4 | TASK-2588 | choda-deck | Each run carries a deploy checklist, and everything Butter must run opens and copies from the companion | NEW `companion-runs` |
| 5 | TASK-2559 | choda-deck | Runs screen: an item row shows its tests and its commit's code change | NEW `companion-runs` |
| 6 | TASK-2534 | choda-deck | Companion: see what loop runs did, and read any task in Vietnamese | NEW `companion-runs` |
| 7 | TASK-2548 | choda-deck | Close a conversation from the companion; keep autopilot's inbox pull to the goal | `feature-conversation-protocol` |
| 8 | TASK-2252 | choda-deck | Postgres test harness can silently skip a .pg.test.ts file on Linux CI | `feature-postgres-remote-backend` |
| 9 | TASK-2427 | choda-deck | [fixture] autopilot item-cycle goal | skip — fixture |
| 10 | TASK-2447 | choda-deck | [fixture] autopilot closed-PR goal | skip — fixture |
| 11 | TASK-2424 | choda-deck | [fixture] autopilot probe goal | skip — fixture |
| 12 | TASK-2513 | business-process-automation | BPA 10: BPA-side integration with WorkHub | NEW `bpa-workhub-integration` |
| 13 | TASK-2542 | business-process-automation | Remove a workflow status the Jira Cloud way | NEW `bpa-workflow-versions-and-status-changes` |
| 14 | TASK-2572 | business-process-automation | Record attachments: images on a BPA record, from the portal or Slack | NEW `bpa-record-attachments` |
| 15 | TASK-2501 | juvenis-maxime | Rubric v3.0 and Anchor Library v3.0, group 2: platform changes | NEW `jm-rubric-v3-scoring` |
| 16 | TASK-2564 | juvenis-maxime | C6 pilot: judge Ownership & Self-Management from revision after feedback | NEW `jm-rubric-v3-scoring` |
| 17 | TASK-2557 | juvenis-maxime | Show how the composite /20 was calculated in the Test scoring result | NEW `jm-rubric-v3-scoring` |
| 18 | TASK-2580 | juvenis-maxime | Prod MCP at k3sai.juvenismaxime.com: score Test scoring runs from claude.ai | `scoring-eval-runner-for-jm-experts` |

## New features — "Why this exists" (plain words)

**companion-runs — Companion Runs: what each loop run did, tested and left for Butter** (choda-deck, workspace `choda-deck-companion`)
When an autopilot or burn-backlog run works through a goal on its own, Butter needs to see afterwards what it finished, how it was tested, what it changed and what is left for him to do — without opening terminals, folders or task bodies. The Runs screen gathers that per run: the goal and its feature, each item with its tests and code change, the test report, and the steps to deploy.

**bpa-workhub-integration — BPA × WorkHub integration** (business-process-automation, workspace `bpa-engine`)
WorkHub, the Ichiba Operating Platform, needs to drive business processes that live in BPA: it opens records, decides approvals and hears when a record moves. Without this the two systems do not talk and approvals and record changes are copied by hand. This makes BPA a service WorkHub can call and listen to, under its own key, without giving it a user's rights.

**bpa-workflow-versions-and-status-changes — Workflow versions and status changes** (business-process-automation, workspace `bpa-engine`)
A business process changes over time: steps are added, removed and rolled back. Records that sit in a step must never be stranded when that happens. This covers how a step is removed by moving its records first, how a rollback asks where records go, and what a published change will do before it is made.

**bpa-record-attachments — Record attachments** (business-process-automation, workspace `bpa-engine`)
People report problems with screenshots. A record in BPA needs to carry those images, whether someone uploads them in the portal or the Claude agent attaches them from a Slack thread, so whoever picks up the record sees what the reporter saw.

**jm-rubric-v3-scoring — Rubric v3.0 scoring** (juvenis-maxime, workspace `juvenis-maxime-ai`)
Candidates' answers are scored against a rubric of competencies. Version 3.0 changes what is judged and how the final score out of 20 is put together. This covers the new rubric, how each competency is judged, and showing an expert how a candidate's score was reached.

## Where files land

- `companion-runs` → `C:\dev\choda-deck\docs\knowledge\` (this run's branch, in this task's commit).
- BPA features → `C:\dev\test\bpa-engine\docs\knowledge\`, committed in bpa-engine on its own branch `docs/runs-feature-backfill-2026-10-21`, never on a run branch.
- `jm-rubric-v3-scoring` → `C:\dev\test\JuvenisMaxime.AI\docs\knowledge\`, same rule.
- Links are REALIZES edges only (`feature_link`); no existing feature file is edited.
