import type { StageRunResult } from './stage-runner'
import type {
  GeneratorArtifact,
  GeneratorFile,
  GeneratorOutput,
  GeneratorStatus
} from './generated-types'
import { HarnessError } from './errors'

// Distinct from StageInvalidOutputError: Claude's stdout was valid JSON, but
// the inner `result` string wasn't parseable as a GeneratorOutput object.
export class GeneratorOutputParseError extends HarnessError {
  constructor(
    public readonly rawResult: string,
    public readonly reason: string
  ) {
    super(
      'GENERATOR_OUTPUT_PARSE',
      `Generator result string was not valid output JSON (${reason}): ${rawResult.slice(0, 300)}`
    )
    this.name = 'GeneratorOutputParseError'
  }
}

const VALID_ACTIONS = new Set<GeneratorFile['action']>(['create', 'edit', 'delete'])
const VALID_STATUS = new Set<GeneratorStatus>(['complete', 'stopped'])

export function parseGeneratorResult(result: StageRunResult): GeneratorOutput {
  const text = result.parsed.result ?? ''
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const payload = fenced ? fenced[1] : trimmed
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new GeneratorOutputParseError(text, 'not valid JSON')
  }
  return coerceOutput(parsed, text)
}

function coerceOutput(raw: unknown, rawText: string): GeneratorOutput {
  if (!raw || typeof raw !== 'object') {
    throw new GeneratorOutputParseError(rawText, 'not an object')
  }
  const obj = raw as Record<string, unknown>
  const status = obj.status
  if (typeof status !== 'string' || !VALID_STATUS.has(status as GeneratorStatus)) {
    throw new GeneratorOutputParseError(rawText, `invalid status: ${String(status)}`)
  }
  const files = coerceFiles(obj.files, rawText)
  const stopReason =
    typeof obj.stopReason === 'string' && obj.stopReason.trim().length > 0
      ? obj.stopReason.trim()
      : null
  if (status === 'stopped' && !stopReason) {
    throw new GeneratorOutputParseError(rawText, 'status=stopped requires non-empty stopReason')
  }
  return {
    status: status as GeneratorStatus,
    stopReason,
    files,
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    diff: typeof obj.diff === 'string' ? obj.diff : ''
  }
}

function coerceFiles(raw: unknown, rawText: string): GeneratorFile[] {
  if (!Array.isArray(raw)) return []
  return raw.map((f, i) => {
    if (!f || typeof f !== 'object') {
      throw new GeneratorOutputParseError(rawText, `files[${i}] is not an object`)
    }
    const fo = f as Record<string, unknown>
    if (typeof fo.path !== 'string' || typeof fo.action !== 'string') {
      throw new GeneratorOutputParseError(rawText, `files[${i}] missing path/action`)
    }
    if (!VALID_ACTIONS.has(fo.action as GeneratorFile['action'])) {
      throw new GeneratorOutputParseError(rawText, `files[${i}] invalid action: ${fo.action}`)
    }
    return { path: fo.path, action: fo.action as GeneratorFile['action'] }
  })
}

export function splitArtifact(output: GeneratorOutput): {
  artifact: GeneratorArtifact
  diff: string
} {
  return {
    artifact: {
      status: output.status,
      stopReason: output.stopReason,
      files: output.files,
      summary: output.summary
    },
    diff: output.diff
  }
}
