// TASK-2340 — what Claude was doing when the user pushed back. For each
// interruption / correction turn, the tools and files of the run being stopped
// or corrected. Tool names and paths only — never message text — so the skill
// can group repeated mistakes without reading transcripts (ADR-036 §5).

export const MAX_MISTAKES = 50
const MAX_PATHS = 5

export interface Mistake {
  kind: 'interruption' | 'correction'
  workspace: string
  tools: string[]
  /** Workspace-relative when under the workspace, else the normalized absolute path. */
  paths: string[]
}

export interface RunAction {
  tools: string[]
  paths: string[]
}

interface ToolUseBlock {
  type?: unknown
  name?: unknown
  input?: { file_path?: unknown; path?: unknown; notebook_path?: unknown }
}

function relativeTo(p: string, workspace: string): string {
  const n = p.replace(/\\/g, '/').toLowerCase()
  return n.startsWith(workspace + '/') ? n.slice(workspace.length + 1) : n
}

/**
 * Accumulates the tool uses of each session's current run — everything the
 * assistant did since the user's last real turn. Tool results arrive as user
 * rows but are not turns, so they never reset a run.
 */
export class RunTracker {
  private readonly runs = new Map<string, { tools: Set<string>; paths: Set<string> }>()

  record(session: string, content: unknown, workspace: string): void {
    if (!Array.isArray(content)) return
    for (const b of content as ToolUseBlock[]) {
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue
      let run = this.runs.get(session)
      if (!run) this.runs.set(session, (run = { tools: new Set(), paths: new Set() }))
      run.tools.add(b.name)
      const p = b.input?.file_path ?? b.input?.path ?? b.input?.notebook_path
      if (typeof p === 'string' && p) run.paths.add(relativeTo(p, workspace))
    }
  }

  /** The run that ended at this user turn; starts a fresh one. */
  take(session: string): RunAction {
    const run = this.runs.get(session)
    this.runs.delete(session)
    return {
      tools: run ? [...run.tools].sort() : [],
      paths: run ? [...run.paths].sort().slice(0, MAX_PATHS) : []
    }
  }
}
