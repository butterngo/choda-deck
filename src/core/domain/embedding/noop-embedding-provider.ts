import type { EmbeddingProvider } from './embedding-provider.interface'
import { EmbeddingProviderUnavailableError } from './embedding-provider.interface'

export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'noop'
  readonly dims = 0

  private readonly reason: string

  constructor(reason: string) {
    this.reason = reason
  }

  async embed(): Promise<Float32Array> {
    throw new EmbeddingProviderUnavailableError(this.reason)
  }

  async embedBatch(): Promise<Float32Array[]> {
    throw new EmbeddingProviderUnavailableError(this.reason)
  }
}
