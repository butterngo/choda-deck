import type { EmbeddingProvider } from './embedding-provider.interface'
import { EmbeddingProviderUnavailableError } from './embedding-provider.interface'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

// TASK-1743 — where to load MODEL_ID's files from, instead of fetching them
// from the HuggingFace hub on first use.
//
// Unset (dev, CLI, MCP server): unchanged behaviour — transformers.js downloads
// the model and caches it under its own package directory. That is fine for a
// checkout with a network connection and a writable node_modules.
//
// Set (the packaged companion app): the adapter ships the model files inside
// its own resources, so it must load them from there and never reach for the
// network. Without this the packaged app either fails offline or writes a 90 MB
// cache into the install directory the first time someone searches.
//
// The value is a directory laid out the way `env.localModelPath` expects —
// `<dir>/<modelId>/<file>`, i.e. the q8 onnx file under
// `<dir>/Xenova/all-MiniLM-L6-v2/onnx/` (transformers v4 derives its name from the dtype).
const MODEL_DIR_ENV = 'CHODA_EMBEDDING_MODEL_DIR'

// TASK-3203 — the variant is part of the id. Vectors from different variants
// are not comparable, so a variant change must change the id: the store sees
// the mismatch and clears every stored vector for the backfill to re-embed.
// scripts/backfill-embeddings.mjs must use the same id and dtype.
export const LOCAL_PROVIDER_ID = 'local-minilm-l6-v2-q8'
export const LOCAL_MODEL_DTYPE = 'q8'

type FeaturePipeline = (
  text: string,
  options?: { pooling?: 'mean'; normalize?: boolean }
) => Promise<{ data: Float32Array | ArrayLike<number> }>

type TransformersEnv = {
  allowLocalModels: boolean
  allowRemoteModels: boolean
  localModelPath: string
}

type TransformersModule = {
  env: TransformersEnv
  pipeline(
    task: string,
    model: string,
    opts?: { dtype?: string }
  ): Promise<FeaturePipeline>
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly id = LOCAL_PROVIDER_ID
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
      // Deliberately only narrows when the override is present: with it unset
      // the module's own defaults apply untouched, so nothing about the dev
      // path changes. `allowRemoteModels = false` is the half that matters —
      // it turns a silent network fetch into a loud error if the vendored
      // files are missing or misplaced, rather than a first-search hang.
      const modelDir = process.env[MODEL_DIR_ENV]
      if (modelDir !== undefined && modelDir.length > 0) {
        mod.env.allowLocalModels = true
        mod.env.localModelPath = modelDir
        mod.env.allowRemoteModels = false
      }

      return mod.pipeline('feature-extraction', MODEL_ID, { dtype: LOCAL_MODEL_DTYPE })
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
