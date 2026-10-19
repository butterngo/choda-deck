---
type: gotcha
title: A self-skipping pg suite must fail on Linux CI when its precondition check fails
projectId: choda-deck
scope: project
refs:
  - path: src/test/pg-docker-global-setup.ts
    commitSha: 5ff422509137117d73fe0a9e93a7dd0f7232ff7c
  - path: src/test/postgres-harness.ts
    commitSha: 5ff422509137117d73fe0a9e93a7dd0f7232ff7c
  - path: vitest.config.ts
    commitSha: 5ff422509137117d73fe0a9e93a7dd0f7232ff7c
createdAt: 2026-10-15
lastVerifiedAt: 2026-10-19
affectedFeatureId: feature-postgres-remote-backend
---

## Trigger

A test harness decides whether to run or skip a suite from an environment probe, such as `docker info`. The probe runs once per vitest worker, at module load, with a short timeout.

## Context

The Postgres suites (`*.pg.test.ts`) use testcontainers. `describeIfDocker` skipped them when Docker was not detected. Detection ran in every worker with a 5 s timeout.

On ubuntu CI, under parallel load, one worker's `docker info` timed out (CI run 36835364934, TASK-2252). That worker's pg files skipped while the other workers' pg files ran. The job stayed green: part of the pg coverage disappeared and nothing reported it. A skip on a machine that *should* have Docker reads exactly like a skip on a machine that does not.

## Business rule

- **Probe once per run, not once per worker.** Run the probe in a vitest `globalSetup` and hand the single result to workers with `project.provide()` / `inject()`. Give it a generous timeout. It runs once, so a slow answer under load costs one wait instead of becoming a false "no Docker".
- **Fail where the precondition is guaranteed.** On a Linux CI runner, where Docker is guaranteed, a failed probe must register a **failing** test that carries the probe's error text, never a skip.
- **Skip only where the precondition is genuinely optional.** That means local machines and Windows CI, whose Docker runs in Windows-container mode.

## Resolution

- **`src/test/pg-docker-global-setup.ts`** (TASK-2473, c49f94f) contains:
  - `detectLinuxDocker()`, which runs `docker info --format {{.OSType}}` with a 20 s timeout and is ok only when the result is `linux`;
  - one log line per run;
  - `provide('pgDocker', { ok, error })`.
- **`src/test/postgres-harness.ts`** (TASK-2474, 5ff4225): `pgSuiteMode({ ci, platform, docker })` returns `'run' | 'fail' | 'skip'`, and `suiteForMode()` turns `'fail'` into a single test that throws `Docker detection failed on Linux CI — <error>`. `CI` counts as set when it is truthy and not the string `'false'`.
- **Verification:**
  - 3 ubuntu runs on PR #356 ran 14 pg files each with 0 skipped.
  - The Windows job still skips all 14 pg files and stays green.
  - A discriminator check proved the guard: replacing the fail branch with `describe.skip` turns its unit test red.

## Related

- `vitest-can-report-pass-while-silently-not-running-test-files-check-the-file-coun`: the same family of failure (green, with less coverage than you think). That entry catches it from the file count; this one prevents it at the source.
