// ADR-030 — testcontainers harness. Boots a throwaway Postgres 16 per
// test file so the Postgres repository suite can exercise real SQL without
// shared state between files.
//
// Tests should self-skip when Docker is unavailable (Windows CI today,
// dev machines without Docker Desktop running) — use `describeIfDocker`
// at the top of each .pg.test.ts file.

import { describe, inject } from 'vitest'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer
} from '@testcontainers/postgresql'
import { PgConnection } from '../core/domain/repositories/postgres/connection'

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

export const dockerAvailable = pgDocker?.ok ?? false
export const describeIfDocker = dockerAvailable ? describe : describe.skip
