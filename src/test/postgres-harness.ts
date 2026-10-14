// ADR-030 — testcontainers harness. Boots a throwaway Postgres 16 per
// test file so the Postgres repository suite can exercise real SQL without
// shared state between files.
//
// Tests should self-skip when Docker is unavailable (Windows CI today,
// dev machines without Docker Desktop running) — use `describeIfDocker`
// at the top of each .pg.test.ts file. On Linux CI a failed detection fails
// the suite instead (TASK-2474).

import { describe, inject, it } from 'vitest'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer
} from '@testcontainers/postgresql'
import { PgConnection } from '../core/domain/repositories/postgres/connection'
import type { PgDockerResult } from './pg-docker-global-setup'

export interface PgTestEnv {
  container: StartedPostgreSqlContainer
  conn: PgConnection
  connectionString: string
}

// Image choice: `pgvector/pgvector:pg16` — postgres 16 with pgvector
// pre-installed. The 2026-05-28 PG narrowing removed knowledge_embeddings
// (vector column) from the schema, so the extension is no longer required.
// Image pin kept on the vector variant anyway for parity with the prod
// k8s image (TASK-936) — minimal cost (~250MB vs 80MB alpine) and the
// cache is amortized across every later container.
export async function startPostgresTestEnv(): Promise<PgTestEnv> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('choda_test')
    .withUsername('choda')
    .withPassword('choda')
    .start()
  const connectionString = container.getConnectionUri()
  const conn = new PgConnection(connectionString)
  return { container, conn, connectionString }
}

export async function stopPostgresTestEnv(env: PgTestEnv): Promise<void> {
  try {
    await env.conn.close()
  } catch {
    // Pool may already be closed by a previous teardown call.
  }
  await env.container.stop()
}

// Docker detection runs once per vitest run in pg-docker-global-setup.ts
// (TASK-2473), not here: a per-worker `docker info` could time out under load and
// skip one worker's files. inject() returns undefined only when that globalSetup
// was not registered, which counts as "no Docker" rather than a crash.
const pgDocker = inject('pgDocker')

export type PgSuiteMode = 'run' | 'fail' | 'skip'

export interface PgSuiteInput {
  ci: boolean
  platform: NodeJS.Platform
  docker: PgDockerResult | undefined
}

// TASK-2474 — Linux CI is where Docker is expected, so a failed detection there is
// a broken run, not an environment without Docker: it fails instead of skipping,
// otherwise the job goes green with pg suites unrun (TASK-2252). Windows CI (Docker
// in Windows-container mode) and local machines without Docker keep self-skipping.
export function pgSuiteMode({ ci, platform, docker }: PgSuiteInput): PgSuiteMode {
  if (docker?.ok) return 'run'
  return ci && platform === 'linux' ? 'fail' : 'skip'
}

type SuiteFn = (name: string, fn: () => void) => void

export interface SuiteApi {
  describe: SuiteFn
  skip: SuiteFn
  it: (name: string, fn: () => void) => void
}

/** The describe-like wrapper for a mode; the api is injected so tests can drive it. */
export function suiteForMode(mode: PgSuiteMode, error: string | null, api: SuiteApi): SuiteFn {
  if (mode === 'run') return api.describe
  if (mode === 'skip') return api.skip
  return (name) =>
    api.describe(name, () => {
      api.it('has a Linux Docker engine', () => {
        throw new Error(`Docker detection failed on Linux CI — ${error ?? 'no detection result'}`)
      })
    })
}

const ci = !!process.env.CI && process.env.CI !== 'false'

export const dockerAvailable = pgDocker?.ok ?? false
export const describeIfDocker = suiteForMode(
  pgSuiteMode({ ci, platform: process.platform, docker: pgDocker }),
  pgDocker?.error ?? null,
  { describe, skip: describe.skip, it }
)
