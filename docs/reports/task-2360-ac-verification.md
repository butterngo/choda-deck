# TASK-2360 — AC verification

Improve loop settings form (`views/ImproveSettings.tsx` + `lib/improve-form.ts`) in the
companion, opened from the Improve tab's Settings button. Merged in choda-deck-companion
PR #171 (`fc1b0bd`), proven an ancestor of `origin/main`. The companion has no CI workflows.

## Done — 4/4

| # | Criterion | Evidence |
|---|---|---|
| 0 | Save sends `PUT /improve/:ws/config`; reopening with the GET returning that body shows the same values in every field | 6 fields edited (url, pages, a numeric target, a criterion's `by`, mode, max proposals); the PUT body is asserted; a fresh mount whose GET returns the saved body reads back 20+ field values identical to before Save. A control saves untouched and gets the stored config back exactly |
| 1 | A 400 for `criteria[1].target` renders under row 2's target input, not elsewhere | the message is in `improve-crit-target-error-1`, inside row `improve-crit-1`, in the target cell; it is the only `role=alert` on the page and the top-level error list is absent |
| 2 | No project or workspace selector; the workspace comes from the route | no combobox or label matching `/project\|workspace/`; the PUT goes to the workspace ImproveTab was given |
| 3 | A workspace with no config opens on Manual | `config: null` → Manual `aria-checked`, Off and Scheduled not |

Every test drives the form through the Improve tab with `fetch` stubbed, so the real hooks
and the real PUT run.

## Findings

- **Round-trip needed a conversion layer.** The form edits strings (a pages textarea, typed
  targets). `lib/improve-form.ts` turns a numeric-looking target back into a number, drops
  empty `startCmd` / `testCmd` / `spec`, and keeps `good`, so an untouched save is a no-op.
- **No error is dropped.** A field path no input owns (e.g. `""`) is listed above the form.
  `pages[2]` folds into the pages textarea's message.
- **The token estimate is a heuristic**: 4k + agent criteria × pages × 2 screenshots × 1.6k.
  It is labelled as an estimate; nothing bills against it.
- **`DocDiagrams.test.tsx` failed in two full runs in a row** (TASK-2359 and this one), the
  same 2 tests each time, and passes 12/12 alone. It was 1 in 8 during TASK-2356. It is
  getting more frequent, and it is untouched by this change.
- The live screen is still behind the companion service restart noted in TASK-2365.
