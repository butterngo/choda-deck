export class EmbeddingProviderUnavailableError extends Error {
  constructor(reason: string) {
    super(`Embedding provider unavailable: ${reason}`)
    this.name = 'EmbeddingProviderUnavailableError'
  }
}

export interface EmbeddingProvider {
  readonly id: string
  readonly dims: number
  embed(text: string): Promise<Float32Array>
  embedBatch(texts: string[]): Promise<Float32Array[]>
}
