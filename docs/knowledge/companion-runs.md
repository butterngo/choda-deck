---
type: feature
title: "Companion Runs: what each loop run did, tested and left for Butter"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-10-21
lastVerifiedAt: 2026-10-21
realizesTasks: ["TASK-2534","TASK-2559","TASK-2585","TASK-2586","TASK-2587","TASK-2588"]
inWorkspaces: ["main","choda-deck-companion"]
status: in-progress
---

## Why this exists

When an autopilot or burn-backlog run works through a goal on its own, Butter needs to see afterwards what it finished, how it was tested, what it changed and what is left for him to do — without opening terminals, folders or task bodies. The Runs screen gathers that per run: the goal and its feature, each item with its tests and code change, the test report, and the steps to deploy.

## What it covers

- One card per run, grouped by project, with the goal's feature and its stage
- Each item opens to its tests, the test cases its commits added, and its commits with files and diff
- A test report per run, with a smoke test against a real environment
- A deploy checklist per run, where everything Butter must run can be opened and copied

## Realized by

Goals TASK-2534, TASK-2559, TASK-2585, TASK-2586, TASK-2587, TASK-2588.
