// TASK-2473 — Docker detection for the Postgres harness, once per vitest run.
//
// Detection used to run at module load in EACH worker with a 5 s timeout. Under
// parallel load on ubuntu CI one worker's `docker info` could time out, and that
// worker's .pg.test.ts files skipped while the rest ran (TASK-2252, CI run
// 36835364934). A globalSetup runs once in the main process, before any worker,
// and hands the single result to every worker through provide/inject.

import { execFileSync } from 'node:child_process'
import type { TestProject } from 'vitest/node'
import { splitLines } from '../core/utils/lines'

/** Generous on purpose: a slow answer under load must not read as "no Docker". */
export const DOCKER_DETECT_TIMEOUT_MS = 20000

export interface PgDockerResult {
  ok: boolean
  /** Why detection failed; null when ok. */
  error: string | null
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgDocker: PgDockerResult
  }
}

// Detect Docker AND verify it can run Linux containers. GitHub's windows-latest
// runner ships Docker in *Windows-container mode*, where `docker ps` succeeds but
// testcontainers fails at the volume-mount step with "invalid volume
// specification: '//var/run/docker.sock:/var/run/docker.sock:rw'". Filtering on
// OSType=linux self-skips that case while still running locally on Docker
// Desktop (Linux mode) and on Linux CI.
export function detectLinuxDocker(): PgDockerResult {
  try {
    const out = execFileSync('docker', ['info', '--format', '{{.OSType}}'], {
      timeout: DOCKER_DETECT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
      .toString()
      .trim()
    return out === 'linux'
      ? { ok: true, error: null }
      : { ok: false, error: `docker OSType is "${out}", not "linux"` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? splitLines(err.message)[0] : String(err) }
  }
}

export default function setup(project: TestProject): void {
  const result = detectLinuxDocker()
  console.log(
    result.ok
      ? 'pg-harness: docker detection ok (linux)'
      : `pg-harness: docker detection failed — ${result.error}`
  )
  project.provide('pgDocker', result)
}
