import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { resolveDataPaths } from '../../../core/paths'
import { renderQueueReport } from '../../../core/executor/queue-report'

export const queueReportHelp = `Usage: choda-deck queue report <queueRunId>
       choda-deck queue report --from <queueRunDir>

Regenerate report.md for an existing artifact directory.

Arguments:
  <queueRunId>          Queue run ID (e.g. 1778471338165-1qtq) — resolves to
                        <CHODA_DATA_DIR>/artifacts/queue-<queueRunId>/

Options:
  --from <path>         Explicit path to artifact directory
  --help                Show this help

Exit codes:
  0    report.md written successfully
  1    artifact directory not found or queue-run.json malformed
`

export async function runQueueReportCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: true,
    strict: true
  })

  if (parsed.values.help) {
    process.stdout.write(queueReportHelp)
    return 0
  }

  let queueRunDir: string
  if (parsed.values.from) {
    queueRunDir = path.resolve(parsed.values.from)
  } else {
    const queueRunId = parsed.positionals[0]
    if (!queueRunId) {
      process.stderr.write(
        `error: <queueRunId> or --from <path> is required\n\n${queueReportHelp}`
      )
      return 1
    }
    const { artifactsDir } = resolveDataPaths()
    queueRunDir = path.join(artifactsDir, `queue-${queueRunId}`)
  }

  if (!fs.existsSync(queueRunDir)) {
    process.stderr.write(`error: artifact directory not found: ${queueRunDir}\n`)
    return 1
  }

  let markdown: string
  try {
    markdown = await renderQueueReport(queueRunDir)
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  const reportPath = path.join(queueRunDir, 'report.md')
  fs.writeFileSync(reportPath, markdown, 'utf8')
  process.stdout.write(`report written: ${reportPath}\n`)
  return 0
}
