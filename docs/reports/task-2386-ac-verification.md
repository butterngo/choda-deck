# TASK-2386 — AC verification

The daily digest becomes "numbers every day, one change a week":

- **Skill** `~/.claude/skills/daily-digest/SKILL.md` (outside git, previous version kept in the
  session scratchpad). Every run computes the digests with the CLI and nothing else. On Mondays,
  or with `--force-week`, it files ONE inbox item
  `[activity-digest] Tuần <yyyy-Www>: <change>`: why, the number it should move, and a follow-up
  on last week's item. Thread summaries and the 2-day diagnosis are gone, and so are proposals
  about the measurement itself.
- **Companion** `components/WeekCompare.tsx` at the top of the Activity screen: the four metrics
  this week vs last week, with an arrow and "higher/lower is better · getting better/worse" in
  words. Companion PR #179 (`871b4b5`).

## Done — 4/5

| # | Criterion | Evidence |
|---|---|---|
| 0 | Non-Monday run: digests computed, no inbox item, no thread message | headless `/daily-digest --date 2026-10-11` (a Sunday): `weekly: not today`; `[activity-digest]` inbox items 15 → 15, thread messages 27 → 27 |
| 1 | Forced week: exactly one `Tuần …` item, one metric, a follow-up line | headless `--force-week`: INBOX-2202 `Tuần 2026-W41: Merge và đóng từng task trong ngày…`, "Shipped tuần này 191 (tuần trước 213)", `Tuần trước: tuần đầu tiên`; the thread was untouched |
| 2 | The item shows in the decide screen's digest block | live `GET /inbox/pending`: INBOX-2202 is item 0, source `activity-digest` |
| 3 | Activity header: 4 metrics, arrows, "better" hint; absent below 8 days | `WeekCompare.test.tsx`: 14 crafted days put every direction in a known place; 7 days renders nothing; 8 days computes |

## Needs time — 1

After two Mondays, can Butter say what the weekly change was and whether its number moved
(TASK-2391)? This is the real measure of whether the redesign works.

## Findings

- **INBOX-2202 is a real item**, filed by the forced run (week 41). Monday 2026-10-12 starts
  week 42, so the scheduled run will file week 42's item and follow up on this one.
- **Monday only, no catch-up.** A Monday with the PC off skips that week. ChodaActivityDigest
  runs at logon and at 09:00, so a weekday start still covers Monday. Catch-up was left out on
  purpose, because it would contradict "nothing on other days".
- The scheduled task's allowed tools still list the conversation tools; the skill no longer uses
  them, which is harmless.
