import type { EmbeddingProvider } from './embedding-provider.interface'
import { NoopEmbeddingProvider } from './noop-embedding-provider'

export type ProviderKey = 'local' | 'noop'

const ENV_KEY = 'CHODA_EMBEDDING_PROVIDER'

export const resolveProviderKey = (): ProviderKey => {
  const raw = (process.env[ENV_KEY] ?? 'local').toLowerCase().trim()
  if (raw === 'noop' || raw === 'off' || raw === 'false' || raw === '0') return 'noop'
  if (raw === 'local' || raw === '') return 'local'
  throw new Error(`Unsupported ${ENV_KEY}="${raw}". Supported: local, noop`)
}

export const loadEmbeddingProvider = async (
  key: ProviderKey = resolveProviderKey()
): Promise<EmbeddingProvider> => {
  if (key === 'noop') {
    return new NoopEmbeddingProvider(`${ENV_KEY} resolved to "noop"`)
  }
  const mod = await import('./local-embedding-provider')
  return new mod.LocalEmbeddingProvider()
}
