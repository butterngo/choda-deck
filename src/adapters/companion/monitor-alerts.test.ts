import { describe, it, expect, beforeEach } from 'vitest'
import {
  createMonitorAlerts,
  noticeContent,
  THRESHOLD_MS,
  type WaitingRun
} from './monitor-alerts'

// TASK-2859 — the 20-minute waiting notice, with a fake clock, a fake runs
// source and a fake inbox whose `added` array records every inbox_add.

const SINCE = '2026-10-28T09:00:00.000Z'
const T0 = Date.parse(SINCE)
const MIN = 60_000

let clock: number
let waiting: WaitingRun[]
let added: { projectId: string; workspaceId?: string; content: string }[]
let seed: string[]

const run = (since = SINCE): WaitingRun => ({
  goalId: 'TASK-1',
  projectId: 'p',
  workspaceId: 'main',
  sessionId: 'cc-1',
  since
})

function alerts(): ReturnType<typeof createMonitorAlerts> {
  return createMonitorAlerts({
    waitingRuns: async () => waiting,
    rawInboxContents: async () => seed,
    addInbox: async (item) => {
      added.push(item)
    },
    now: () => clock
  })
}

beforeEach(() => {
  clock = T0
  waiting = [run()]
  added = []
  seed = []
})

describe('monitor alerts', () => {
  it('AC-1 a run waiting for 19 min files nothing', async () => {
    clock = T0 + 19 * MIN
    await alerts().check()
    expect(added).toEqual([])
  })

  it('AC-2 the same run at 21 min files exactly one item', async () => {
    clock = T0 + 21 * MIN
    await alerts().check()
    expect(added).toHaveLength(1)
  })

  it('AC-3 the item starts with [monitor: and names the goal id', async () => {
    clock = T0 + 21 * MIN
    await alerts().check()
    expect(added[0].content.startsWith('[monitor:')).toBe(true)
    expect(added[0].content).toContain('TASK-1')
    expect(added[0]).toMatchObject({ projectId: 'p', workspaceId: 'main' })
  })

  it('AC-4 a second check for the same (sessionId, since) files nothing more', async () => {
    clock = T0 + 21 * MIN
    const a = alerts()
    await a.check()
    clock += 5 * MIN
    await a.check()
    expect(added).toHaveLength(1)
  })

  it('AC-5 a new waiting episode for the same session files one more', async () => {
    clock = T0 + 21 * MIN
    const a = alerts()
    await a.check()
    const later = new Date(T0 + 60 * MIN).toISOString()
    waiting = [run(later)]
    clock = Date.parse(later) + 21 * MIN
    await a.check()
    expect(added).toHaveLength(2)
  })

  it('AC-6 a fresh instance seeded with the episode already in the inbox files nothing', async () => {
    seed = [noticeContent(run()), 'unrelated idea']
    clock = T0 + 21 * MIN
    await alerts().check()
    expect(added).toEqual([])
  })

  it('the threshold is exactly 20 minutes', async () => {
    expect(THRESHOLD_MS).toBe(20 * MIN)
    clock = T0 + THRESHOLD_MS
    await alerts().check()
    expect(added).toHaveLength(1)
  })
})
