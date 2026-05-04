import type { EmbeddingProvider } from './embedding-provider.interface'
import { EmbeddingProviderUnavailableError } from './embedding-provider.interface'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

type FeaturePipeline = (
  text: string,
  options?: { pooling?: 'mean'; normalize?: boolean }
) => Promise<{ data: Float32Array | ArrayLike<number> }>

type TransformersModule = {
  pipeline(
    task: string,
    model: string,
    opts?: { quantized?: boolean }
  ): Promise<FeaturePipeline>
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'local-minilm-l6-v2'
  readonly dims = 384

  private pipelinePromise: Promise<FeaturePipeline> | null = null

  private async getPipeline(): Promise<FeaturePipeline> {
    if (this.pipelinePromise) return this.pipelinePromise
    this.pipelinePromise = (async (): Promise<FeaturePipeline> => {
      let mod: TransformersModule
      try {
        mod = (await import('@huggingface/transformers')) as unknown as TransformersModule
      } catch (err) {
        throw new EmbeddingProviderUnavailableError(
          `@huggingface/transformers not installed — run \`pnpm install --include=optional\`: ${(err as Error).message}`
        )
      }
      return mod.pipeline('feature-extraction', MODEL_ID, { quantized: true })
    })()
    return this.pipelinePromise
  }

  async embed(text: string): Promise<Float32Array> {
    const pipe = await this.getPipeline()
    const out = await pipe(text, { pooling: 'mean', normalize: true })
    return toFloat32(out.data)
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const pipe = await this.getPipeline()
    const results: Float32Array[] = []
    for (const t of texts) {
      const out = await pipe(t, { pooling: 'mean', normalize: true })
      results.push(toFloat32(out.data))
    }
    return results
  }
}

function toFloat32(data: Float32Array | ArrayLike<number>): Float32Array {
  return data instanceof Float32Array ? data : Float32Array.from(data)
}
