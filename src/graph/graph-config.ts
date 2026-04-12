import type { GraphService } from './graph-service.interface'

export interface Neo4jProviderConfig {
  provider: 'neo4j'
  uri: string
  username: string
  password: string
  database?: string
}

export interface SqliteProviderConfig {
  provider: 'sqlite'
  path: string
}

export type GraphConfig = Neo4jProviderConfig | SqliteProviderConfig

export type GraphServiceFactory = (config: GraphConfig) => GraphService

/**
 * Registry of provider factories. Implementations register themselves at startup.
 * Consumer code calls createGraphService(config) without knowing which impl is loaded.
 */
const providers = new Map<string, GraphServiceFactory>()

export function registerGraphProvider(name: string, factory: GraphServiceFactory): void {
  providers.set(name, factory)
}

export function createGraphService(config: GraphConfig): GraphService {
  const factory = providers.get(config.provider)
  if (!factory) {
    throw new Error(
      `Unknown graph provider "${config.provider}". ` +
        `Registered: [${Array.from(providers.keys()).join(', ')}]`
    )
  }
  return factory(config)
}
