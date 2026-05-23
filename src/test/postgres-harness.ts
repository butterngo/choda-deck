// ADR-030 — testcontainers harness. Boots a throwaway Postgres 16 per
// test file so the Postgres repository suite can exercise real SQL without
// shared state between files.
//
// Tests should self-skip when Docker is unavailable (Windows CI today,
// dev machines without Docker Desktop running) — use `describeIfDocker`
// at the top of each .pg.test.ts file.

import { execFileSync } from 'node:child_process'
import { describe } from 'vitest'
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

export async function startPostgresTestEnv(): Promise<PgTestEnv> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
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

function detectDockerSync(): boolean {
  try {
    execFileSync('docker', ['ps'], { timeout: 5000, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Resolved synchronously at module load so test files can pick describe vs
// describe.skip without top-level await — which can destabilize Vitest's
// worker pool when a child fork crashes during teardown.
export const dockerAvailable = detectDockerSync()
export const describeIfDocker = dockerAvailable ? describe : describe.skip
