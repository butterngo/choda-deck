import * as fs from 'node:fs'
import * as path from 'node:path'

interface QueueRunMeta {
  queueRunId: string
  workspaceId: string
  branch: string
  model: string
  startedAt: string
  endedAt: string
  totalCostUsd: number
  halted: boolean
  haltReason: string | null
  tasks: Array<{
    id: string
    outcome: string
    costUsd?: number
    numTurns?: number
  }>
}

interface ParsedFile {
  path: string
  change: 'new' | 'modified' | 'deleted'
  added: number
  removed: number
}

interface ParsedAcLog {
  index: number
  missing: false
  command: string
  exitCode: number
  keyResult: string
}

interface MissingAcLog {
  index: number
  missing: true
}

type AcLogEntry = ParsedAcLog | MissingAcLog

export async function renderQueueReport(queueRunDir: string): Promise<string> {
  const queueRunJsonPath = path.join(queueRunDir, 'queue-run.json')
  if (!fs.existsSync(queueRunJsonPath)) {
    throw new Error(`queue-run.json not found in ${queueRunDir}`)
  }

  const meta: QueueRunMeta = JSON.parse(fs.readFileSync(queueRunJsonPath, 'utf8'))
  const lines: string[] = []

  lines.push(`# Queue Run Report — \`${meta.queueRunId}\``)
  lines.push('')
  lines.push('| | |')
  lines.push('|---|---|')
  lines.push(`| Workspace | \`${meta.workspaceId}\` |`)
  lines.push(`| Branch | \`${meta.branch}\` |`)
  lines.push(`| Started | ${formatUtc(meta.startedAt)} |`)
  lines.push(`| Ended | ${formatUtc(meta.endedAt)} |`)
  lines.push(`| Duration | ${formatDuration(meta.startedAt, meta.endedAt)} |`)
  lines.push(`| Model | \`${meta.model}\` |`)
  lines.push(`| Total cost | $${meta.totalCostUsd.toFixed(4)} |`)
  lines.push(`| Halted | ${meta.halted ? 'yes' : 'no'} |`)

  for (const task of meta.tasks) {
    lines.push('')
    lines.push(`## ${task.id}`)
    lines.push('')

    const taskDir = path.join(queueRunDir, 'tasks', task.id)
    const claudeJsonPath = path.join(taskDir, 'claude.json')

    if (!fs.existsSync(claudeJsonPath)) {
      lines.push(`- **Outcome:** ${task.outcome}`)
      lines.push('')
      lines.push('*(spawn crashed — no claude output available)*')
      continue
    }

    lines.push(`- **Outcome:** ${task.outcome}`)
    if (task.costUsd !== undefined && task.numTurns !== undefined) {
      lines.push(`- **Cost:** $${task.costUsd.toFixed(4)} · **Turns:** ${task.numTurns}`)
    }

    const claudeResult = readClaudeResult(claudeJsonPath)
    if (claudeResult) {
      lines.push('')
      lines.push('**What changed:**')
      lines.push(claudeResult)
    }

    const diffPath = path.join(taskDir, 'diff.patch')
    if (fs.existsSync(diffPath)) {
      const files = parseDiff(fs.readFileSync(diffPath, 'utf8'))
      if (files.length > 0) {
        lines.push('')
        lines.push('### Files changed')
        lines.push('')
        lines.push('| File | Change | +/- |')
        lines.push('|---|---|---|')
        let totalAdded = 0
        let totalRemoved = 0
        for (const f of files) {
          const changeLabel =
            f.change === 'new' ? '**new**' : f.change === 'deleted' ? '~~deleted~~' : 'modified'
          lines.push(`| \`${f.path}\` | ${changeLabel} | +${f.added} / −${f.removed} |`)
          totalAdded += f.added
          totalRemoved += f.removed
        }
        lines.push('')
        lines.push(
          `Net: ${files.length} file${files.length === 1 ? '' : 's'}, +${totalAdded} / −${totalRemoved}.`
        )
      }
    }

    const acLogs = readAcLogs(taskDir)
    if (acLogs.length > 0) {
      lines.push('')
      lines.push('### Acceptance criteria — verification')
      lines.push('')
      lines.push('| # | Command | Exit | Key result |')
      lines.push('|---|---|---|---|')
      for (const log of acLogs) {
        if (log.missing) {
          lines.push(`| ${log.index} | *(missing)* | — | MISSING |`)
        } else {
          const exitLabel = log.exitCode === 0 ? '0 ✅' : `${log.exitCode} ❌`
          lines.push(
            `| ${log.index} | \`${escapeTable(log.command)}\` | ${exitLabel} | ${escapeTable(log.keyResult)} |`
          )
        }
      }
    }
  }

  lines.push('')
  lines.push('## Artifacts')
  lines.push('')
  lines.push('```')
  lines.push(buildArtifactTree(queueRunDir))
  lines.push('```')
  lines.push('')

  return lines.join('\n')
}

function readClaudeResult(claudeJsonPath: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as Record<string, unknown>
    const result = raw['result']
    return typeof result === 'string' ? result.trim() : ''
  } catch {
    return ''
  }
}

function parseDiff(patch: string): ParsedFile[] {
  const files: ParsedFile[] = []
  const blocks = patch.split(/(?=^diff --git )/m).filter((b) => b.startsWith('diff --git '))

  for (const block of blocks) {
    const blockLines = block.split('\n')
    const match = blockLines[0].match(/^diff --git a\/.+ b\/(.+)$/)
    if (!match) continue
    const filePath = match[1]

    const isNew = blockLines.some((l) => l.startsWith('--- /dev/null'))
    const isDeleted = blockLines.some((l) => l.startsWith('+++ /dev/null'))

    let added = 0
    let removed = 0
    for (const line of blockLines) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++
      if (line.startsWith('-') && !line.startsWith('---')) removed++
    }

    files.push({
      path: filePath,
      change: isNew ? 'new' : isDeleted ? 'deleted' : 'modified',
      added,
      removed
    })
  }

  return files
}

function readAcLogs(taskDir: string): AcLogEntry[] {
  if (!fs.existsSync(taskDir)) return []
  const logs: AcLogEntry[] = []
  for (let i = 0; ; i++) {
    const logPath = path.join(taskDir, `ac-${i}.log`)
    if (!fs.existsSync(logPath)) break
    logs.push(parseAcLog(i, fs.readFileSync(logPath, 'utf8')))
  }
  return logs
}

function parseAcLog(index: number, content: string): ParsedAcLog {
  const lines = content.split('\n')
  let command = ''
  let exitCode = -1
  let stdout = ''
  let section: 'header' | 'stdout' | 'stderr' = 'header'

  for (const line of lines) {
    if (section === 'header') {
      if (line.startsWith('$ ')) command = line.slice(2)
      else if (line.startsWith('exit ')) exitCode = parseInt(line.slice(5).trim(), 10)
      else if (line === '--- stdout ---') section = 'stdout'
    } else if (section === 'stdout') {
      if (line === '--- stderr ---') section = 'stderr'
      else stdout += line + '\n'
    }
  }

  return { index, missing: false, command, exitCode, keyResult: extractKeyResult(stdout) }
}

function extractKeyResult(stdout: string): string {
  const trimmed = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  if (trimmed.length === 0) return '*(no output)*'
  const testSummary = trimmed.find((l) => l.startsWith('Test Files') || l.startsWith('Tests '))
  if (testSummary) return testSummary
  return trimmed[trimmed.length - 1]
}

function buildArtifactTree(queueRunDir: string): string {
  const output: string[] = [`${path.basename(queueRunDir)}/`]
  appendTree(queueRunDir, '', output)
  return output.join('\n')
}

function appendTree(dir: string, indent: string, output: string[]): void {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1
      return a.name.localeCompare(b.name)
    })

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const isLast = i === entries.length - 1
    const connector = isLast ? '└── ' : '├── '
    const childIndent = indent + (isLast ? '    ' : '│   ')
    if (e.isDirectory()) {
      output.push(`${indent}${connector}${e.name}/`)
      appendTree(path.join(dir, e.name), childIndent, output)
    } else {
      output.push(`${indent}${connector}${e.name}`)
    }
  }
}

function formatUtc(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  const s = Math.round(ms / 1000)
  if (s < 60) return `~${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `~${m}m ${rem}s` : `~${m}m`
}

function escapeTable(s: string): string {
  return s.replace(/\|/g, '\\|')
}
