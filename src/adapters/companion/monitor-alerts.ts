// TASK-2859 — tell Butter when an autopilot run has waited on him too long
// (goal TASK-2854, discovery CONV-1793202011707-3). Runs stalled at the test
// step for up to 9.3 h (INBOX-2382) because nothing said they were waiting.
//
// Rule-based, no model call: the companion server checks every 60 s, and a run
// whose Claude Code session has waited 20 min or more (Butter: "20 30P"; the
// median recorded wait was 36 min, so 30 would miss half) files ONE raw inbox
// item, which the Decide screen already shows. One per waiting episode: the key
// is sessionId + since, written into the item itself, so a restarted server
// reads it back from the inbox instead of filing it again.

export const THRESHOLD_MS = 20 * 60_000
export const CHECK_INTERVAL_MS = 60_000
export const NOTICE_PREFIX = '[monitor:'

export interface WaitingRun {
  goalId: string
  projectId: string
  workspaceId: string | null
  sessionId: string
  since: string
}

export interface MonitorAlertsDeps {
  /** Every run whose Claude Code session is waiting on Butter right now. */
  waitingRuns: () => Promise<WaitingRun[]>
  /** Contents of the raw inbox items, read once to seed the filed episodes. */
  rawInboxContents: () => Promise<string[]>
  addInbox: (item: { projectId: string; workspaceId?: string; content: string }) => Promise<void>
  now?: () => number
}

const episodeKey = (sessionId: string, since: string): string => `${sessionId}@${since}`
const EPISODE_LINE = /^episode (\S+)$/m

function localHhmm(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function noticeContent(run: WaitingRun): string {
  return (
    `${NOTICE_PREFIX}${run.workspaceId ?? run.projectId}] 🟡 run ${run.goalId} waiting on you since ${localHhmm(run.since)}\n` +
    `Its Claude Code session has been waiting for you for 20 min or more.\n` +
    `episode ${episodeKey(run.sessionId, run.since)}`
  )
}

export interface MonitorAlerts {
  /** One pass: file a notice for every run that crossed the threshold this episode. */
  check(): Promise<number>
}

export function createMonitorAlerts(deps: MonitorAlertsDeps): MonitorAlerts {
  const now = deps.now ?? Date.now
  let filed: Set<string> | null = null

  return {
    async check() {
      if (!filed) {
        filed = new Set()
        for (const content of await deps.rawInboxContents()) {
          if (!content.startsWith(NOTICE_PREFIX)) continue
          const m = EPISODE_LINE.exec(content)
          if (m) filed.add(m[1])
        }
      }
      let count = 0
      for (const run of await deps.waitingRuns()) {
        const key = episodeKey(run.sessionId, run.since)
        if (filed.has(key)) continue
        if (now() - Date.parse(run.since) < THRESHOLD_MS) continue
        await deps.addInbox({
          projectId: run.projectId,
          ...(run.workspaceId ? { workspaceId: run.workspaceId } : {}),
          content: noticeContent(run)
        })
        filed.add(key)
        count += 1
      }
      return count
    }
  }
}
