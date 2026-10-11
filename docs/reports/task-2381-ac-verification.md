# TASK-2381 — AC verification

"Cần anh quyết" screen in the companion (`views/DecideView.tsx` at `#/decide`) over
`GET /inbox/pending` (TASK-2380), plus the first sidebar entry with a count badge and the
landing redirect (`views/LandingRedirect.tsx`). Merged in choda-deck-companion PR #176
(`f846273`), proven an ancestor of `origin/main`; the repo has no CI workflows.

## Done — 5/6

| # | Criterion | Evidence |
|---|---|---|
| 0 | Digest block above improve block; first row is the digest item | `decide-view.test.tsx`: the stubbed GET lists the improve item FIRST, so only the view's block order can put the digest on top |
| 1 | Duyệt → convert; Bỏ with reason → archive `{ reason }`; empty reason sends nothing | the requests the stubbed fetch received; whitespace reason → Save disabled, 0 writes; reason trimmed |
| 2 | First sidebar entry "Cần anh quyết" with a count badge; none at 0 | `decide-route.test.tsx`: first link `/decide`; badge "3" for 3; absent for 0 and for an unknown count |
| 3 | `#/` lands on `#/decide` when pending > 0, `#/sync` when 0 | real route table: 1 pending → `/decide`, 0 → `/sync`, an unreadable list (500) → `/sync` |
| 4 | Empty list → empty state naming its sources; unreachable → unreachable state | component tests |

## Needs a human — 1

AC-5, the packaged app opening on this screen with the digest block first, needs the next
companion release. Carried in TASK-2391 (the epic's human-check list).

## Findings

- **Shell.test pinned the sidebar to six destinations** (TASK-1830, "no more menu"). The pin now
  includes `/decide`, with a comment that Butter's 2026-10-11 request supersedes that rule for
  this one entry; any other addition still fails it.
- **The landing test cannot use `createMemoryRouter`.** A data router turns `<Navigate>` into a
  `Request` carrying jsdom's `AbortSignal`, which Node's fetch rejects ("Expected signal to be an
  instance of AbortSignal"), so the redirect never ran under test. The test mounts the same
  `routes` with `useRoutes` in a `MemoryRouter` instead.
- The badge and the screen share one query (`inbox-pending`, polled every 60 s), so they cannot
  disagree on the count.
- Full web suite: 94/95 files, the known intermittent `DocDiagrams` pair.
