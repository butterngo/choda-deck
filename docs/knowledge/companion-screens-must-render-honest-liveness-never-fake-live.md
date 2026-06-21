---
type: gotcha
title: Companion screens must render honest liveness — never fake-live
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-21
lastVerifiedAt: 2026-06-21
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** building a companion pillar screen (Sync Observatory / Workflow Cockpit / Knowledgebase) that displays data from the laptop adapter.

**Context:** the companion's whole reason for existing is to make sync/workflow state *trustworthy*. Rendering old data as if it were live ("everything is in doubt") is the exact failure mode it must not reproduce.

**Business rule:** a screen must visibly distinguish **connected** (fresh) / **stale** (data older than the poll window) / **disconnected** (API unreachable or `loopAlive:false`). It must never show a fresh-looking view when the API or sync loop is down.

**Resolution:** reuse `useHealth` (react-query, 10s poll) + the pure `deriveConn()` classifier and the `StatusBar` treatment from the shell (TASK-1159). `stale` = last good fetch older than 2× the poll interval. Each pillar screen reuses this degraded treatment rather than inventing its own; component tests cover all three states.
