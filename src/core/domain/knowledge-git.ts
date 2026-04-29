import { execFileSync } from 'child_process'

export class KnowledgeGitError extends Error {
  constructor(message: string) {
    super(`Knowledge git: ${message}`)
    this.name = 'KnowledgeGitError'
  }
}

export interface GitOps {
  getHeadSha(cwd: string): string
  countCommitsSince(cwd: string, sinceSha: string, filePath: string): number
  isAncestor(cwd: string, sha: string): boolean
}

export class GitOpsImpl implements GitOps {
  getHeadSha(cwd: string): string {
    return runGit(cwd, ['rev-parse', 'HEAD']).trim()
  }

  countCommitsSince(cwd: string, sinceSha: string, filePath: string): number {
    if (!this.isAncestor(cwd, sinceSha)) {
      return -1
    }
    const out = runGit(cwd, ['log', '--oneline', `${sinceSha}..HEAD`, '--', filePath]).trim()
    if (out === '') return 0
    return out.split(/\r?\n/).length
  }

  isAncestor(cwd: string, sha: string): boolean {
    try {
      execFileSync('git', ['cat-file', '-e', sha], { cwd, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new KnowledgeGitError(`git ${args.join(' ')} failed in ${cwd}: ${msg}`)
  }
}
