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

// Detect Docker AND verify it can run Linux containers (postgres:16-alpine).
// GitHub's windows-latest runner ships Docker in *Windows-container mode*, where
// `docker ps` succeeds but testcontainers fails at the volume-mount step with
// "invalid volume specification: '//var/run/docker.sock:/var/run/docker.sock:rw'".
// Filtering on OSType=linux self-skips that case while still running locally on
// Docker Desktop (Linux mode) and on Linux CI.
function detectLinuxDockerSync(): boolean {
  try {
    const out = execFileSync('docker', ['info', '--format', '{{.OSType}}'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim()
    return out === 'linux'
  } catch {
    return false
  }
}

// Resolved synchronously at module load so test files can pick describe vs
// describe.skip without top-level await — which can destabilize Vitest's
// worker pool when a child fork crashes during teardown.
export const dockerAvailable = detectLinuxDockerSync()
export const describeIfDocker = dockerAvailable ? describe : describe.skip
