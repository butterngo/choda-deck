import { execFileSync } from 'child_process'
import { splitLines } from '../../utils/lines'

// TASK-2312 — what landed on a repo's default branch, and how. Shared by the
// activity digest (merge vs direct-push counts) and `session reconcile` (which
// merged PR names a task). One rule for "is this a PR merge", in one place.

/** CI bots that commit straight to the default branch (e.g. jm-ci image-tag bumps). */
export const BOT_AUTHORS = /^jm-ci$|\[bot\]$/i

/** A GitHub merge commit, or a squash/rebase commit carrying its PR number. */
const PR_SUBJECT = /^Merge pull request #\d+|\(#\d+\)\s*$/

export type CommitKind = 'merge' | 'direct' | 'bot'

export interface DefaultBranchCommit {
  author: string
  subject: string
}

export function classifyCommit(c: DefaultBranchCommit): CommitKind {
  if (BOT_AUTHORS.test(c.author.trim())) return 'bot'
  return PR_SUBJECT.test(c.subject) ? 'merge' : 'direct'
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 15_000
  }).trim()
}

/** `origin/HEAD`'s target (e.g. `origin/master`), falling back to `origin/main`. */
export function defaultRef(cwd: string): string {
  try {
    return git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  } catch {
    return 'origin/main'
  }
}

/** First-parent commits on the default branch; `extra` narrows the range (e.g. --since). */
export function defaultBranchCommits(cwd: string, extra: string[] = []): DefaultBranchCommit[] {
  const out = git(cwd, ['log', defaultRef(cwd), '--first-parent', ...extra, '--format=%an%x09%s'])
  return splitLines(out)
    .filter((l) => l.length > 0)
    .map((l) => {
      const tab = l.indexOf('\t')
      return { author: l.slice(0, tab), subject: l.slice(tab + 1) }
    })
}
