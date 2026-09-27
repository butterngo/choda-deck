---
type: feature
title: "Daily activity digest: Claude activity to daily numbers, diagnosis and proposals"
projectId: choda-deck
workspaceId: main
scope: project
refs:
  - path: src/core/domain/activity/activity-digest.ts
    commitSha: 
  - path: src/core/domain/activity/activity-runner.ts
    commitSha: 
  - path: src/adapters/cli/activity-command.ts
    commitSha: 
  - path: src/adapters/companion/activity.ts
    commitSha: 
  - path: scripts/install-activity-digest-task.mjs
    commitSha: 
createdAt: 2026-09-27
lastVerifiedAt: 2026-09-27
anchorTaskId: TASK-2149
realizesTasks: ["TASK-2150","TASK-2151","TASK-2152","TASK-2153","TASK-2154","TASK-2155","TASK-2161","TASK-2162"]
inWorkspaces: ["main","choda-deck-companion","claude-skills"]
effortBand: L
status: shipped
---

## What it is

A scheduled job turns each day's Claude Code activity into numbers. Every two new days, Claude reads those numbers and proposes a tool, skill or UI change for each problem it finds. Built to answer "what should I build to work better?" from evidence instead of impressions (goals.md Pillar 4, Personalize AI).

Visual version (diagram, steps, data boundary, status): https://claude.ai/artifact/2VLzFNqbJd9BC9TYNkCWsr (private to Butter until shared).

## How one run works

```
Task Scheduler \ChodaActivityDigest (at logon + 09:00)
  └─ claude -p "/daily-digest"                          skill, unattended
       ① runs  choda-deck activity digest --catch-up    CLI, no AI
            reads  ~/.claude/projects/**/*.jsonl        transcripts
                   ~/.claude/history.jsonl              prompt history
                   choda sessions table                 sessions completed
                   git first-parent log, default branch merges per repo
            writes data/artifacts/activity/<date>.json  one file per local day
       ② reads the new files
       ③ posts  DIGEST <date>      → "Activity digest" conversation (local)
       ④ posts  DIAGNOSIS <from..to> every 2 new days
                + one inbox item per proposal "[activity-digest] …" (syncs)
Companion app
       ⑤ GET /activity/digests (reads the files only) → Sync › Activity view
You    triage the inbox → task → build; later digests show whether it helped
```

## Components

| Part | Where | Task |
|---|---|---|
| Metric engine (pure) | `src/core/domain/activity/activity-digest.ts` | TASK-2150 |
| CLI `choda-deck activity digest` | `src/adapters/cli/activity-command.ts`, `activity-runner.ts` | TASK-2151 |
| Adapter route `GET /activity/digests` | `src/adapters/companion/activity.ts` | TASK-2152 |
| Activity view | companion `packages/web/src/views/ActivityView.tsx`, link in the Sync view header | TASK-2153 |
| Skill `/daily-digest` | `~/.claude/skills/daily-digest/SKILL.md` | TASK-2154, TASK-2161 |
| Scheduled task | `scripts/install-activity-digest-task.mjs` | TASK-2155 |

## Metrics that matter

The four success metrics are: shipped (`sessionsCompleted + mergesToDefault`), `confirmationRate`, `waitMinutes` and `switchesPerActiveHour`. Days are bucketed in local time (Asia/Ho_Chi_Minh). The CLI is deterministic: running it twice on the same day's data gives identical files apart from `generatedAt`. It keeps 90 days and `--catch-up` fills any missing day in the last 7.

## Data boundary

- **Local only:** digest files, the "Activity digest" conversation, and every prompt (in `~/.claude`).
- **Syncs:** inbox items only, so they carry metrics and patterns and never prompt text. A check confirmed that no item contains any 20-character stretch of that day's prompts (ADR-036 §5).
- **Never:** keystrokes, screen or other apps. Only Claude and git activity is used on this corporate machine. The companion never opens `~/.claude`.

## Results so far

- The first DIAGNOSIS (2026-09-25..26) produced three proposals:
  - the `/next` skill, which is built (TASK-2163, INBOX-2110);
  - a "needs you" strip for sessions waiting on the user (INBOX-2108);
  - a weekly allowlist review built from denied tools (INBOX-2109).
- Baseline 2026-09-25: 111 prompts, confirmations 8%, waiting 45% of active time, 8.1 switches per active hour, 24 shipped.
- 2026-09-26: 43 shipped and 16.7 switches per active hour. Parallel sessions cut the waiting time but doubled the switching.

## Known gaps

- Inbox has no label field, so "labelled activity-digest" means the content starts with `[activity-digest]` (INBOX-2112 asks Butter to confirm).
- The transcript `.jsonl` format is undocumented (observed on Claude Code v2.1.281). The engine counts unknown row types rather than failing.
