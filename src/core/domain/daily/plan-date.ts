import { DEFAULT_TZ, localDate } from '../activity/activity-digest'

// TASK-2670 — the day the daily report (TASK-2669) speaks about. A day runs
// 05:00 → 05:00 local, not midnight → midnight: work done at 00:30 still belongs
// to the evening it started in, so the boundary sits where Butter's day actually
// ends. Shifting the instant back by DAY_START_HOUR and taking the plain local
// date gives exactly that, with no special case around midnight.

export const DAY_START_HOUR = 5

/** YYYY-MM-DD of the 05:00 → 05:00 local day that contains `nowMs`. */
export function planDate(nowMs: number, tz: string = DEFAULT_TZ): string {
  return localDate(nowMs - DAY_START_HOUR * 60 * 60 * 1000, tz)
}
