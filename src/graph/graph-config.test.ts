import { describe, it, expect, beforeEach } from 'vitest'
import { createGraphService, registerGraphProvider } from './graph-config'
import type { GraphService } from './graph-service.interface'
import type { Neo4jProviderConfig, SqliteProviderConfig } from './graph-config'

// Minimal stub that satisfies the interface
const stubService = {} as GraphService

describe('registerGraphProvider + createGraphService', () => {
  beforeEach(() => {
    // Register fresh providers per test to avoid cross-test pollution
    registerGraphProvider('neo4j', () => stubService)
    registerGraphProvider('sqlite', () => stubService)
  })

  it('returns a service for a registered neo4j provider', () => {
    const config: Neo4jProviderConfig = {
      provider: 'neo4j',
      uri: 'bolt://localhost:7687',
      username: 'neo4j',
      password: 'test'
    }
    expect(createGraphService(config)).toBe(stubService)
  })

  it('returns a service for a registered sqlite provider', () => {
    const config: SqliteProviderConfig = {
      provider: 'sqlite',
      path: './graph.db'
    }
    expect(createGraphService(config)).toBe(stubService)
  })

  it('throws for an unknown provider', () => {
    const config = { provider: 'unknown' } as never
    expect(() => createGraphService(config)).toThrow('Unknown graph provider "unknown"')
  })

  it('error message lists registered providers', () => {
    const config = { provider: 'mongo' } as never
    expect(() => createGraphService(config)).toThrow(/Registered:.*neo4j.*sqlite/)
  })
})
