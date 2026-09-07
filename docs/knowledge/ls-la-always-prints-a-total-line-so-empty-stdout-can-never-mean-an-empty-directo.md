---
type: gotcha
title: ls -la always prints a total line, so empty stdout can never mean an empty directory
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/docker-exec.ts
    commitSha: 1af24ace7b30b8c1e20dc8990840f59c9fce41dd
createdAt: 2026-09-07
lastVerifiedAt: 2026-09-07
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** a route runs a command, reads its stdout, finds nothing there, and renders "nothing there" — an empty directory, no matches, no rows. The command exited 0, so the answer looks earned.

**Context:** `/docker/exec/ls` parsed `ls -la` output into entries and answered `200 {"entries": []}` when the parse produced none. The pane said "This directory is empty" for every path in every container for as long as the feature existed, because the transport underneath was returning nothing at all (see [[a-docker-verb-that-streams-needs-the-connection-over-a-tcp-docker-host-it-return]]).

The transport bug is fixable and specific to one machine's configuration. This one is not: the route **could not have detected the failure** even in principle, because it had collapsed two different facts into one rendering. That is the part worth remembering.

**Business rule:** if a read's success and its failure produce the same bytes, the read cannot be believed, and no amount of care further down will recover the difference. Before rendering "empty", find the token that ONLY a successful run emits and treat its absence as a failure.

`ls -la` hands you exactly that token for free: it always prints a `total N` line, and an empty directory prints `total 0`. So:

* output with a total line and no entries → a genuinely empty directory, 200
* output with no total line → the listing did not happen, 502 "the container returned nothing"

The discriminator is the total line, NOT the entry count — an empty directory is a real state and must still render as one. Both cases carry a CONTROL test for that reason.

**Resolution:** `docker-exec.ts` holds `TOTAL_LINE = /^total\s/im` and checks it before parsing. Two tests prove the failure direction (empty stdout, stderr-only) and two prove the control direction (`total 0` → empty, `total 8` + one row → one entry).

The generalisation, for the next route that reads a command: ask what a successful run prints that a lost one does not. If the answer is "nothing", the shape of the read is wrong — not its error handling.

Found in TASK-1894 (#280, `1af24ac`), shipped in companion 0.12.2.
