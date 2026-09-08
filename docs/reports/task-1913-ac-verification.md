---
task: TASK-1913
title: An unanswered criterion says so, instead of reading as approved
verified: 2026-09-08
session: SESSION-1788864594462-51
run: /choda-burn-backlog (auto-merge authorized, dynamic pacing, scope label ac-review)
---

# AC verification — TASK-1913

**Done: 4/4 machine criteria. Needs a human: none. Blockers: none.**

Merged and proven in both repos before any tick:

| Repo | PR | Merge commit | Ancestor of `origin/main` |
|---|---|---|---|
| choda-deck | #281 | `608b5b2` | yes |
| choda-deck-companion | #129 | `7350948` | yes |

## Criteria

| AC | Class | Verdict | Evidence |
|---|---|---|---|
| AC-1 | machine | ✅ | Post-merge run on `608b5b2`: a provider reply answering only index 1 yields index 0 `unanswered` and index 1 `ok`, asserted to differ from each other in the same test |
| AC-2 | machine | ✅ | Same run: the `unanswered` row's `concern` contains "no verdict", `suggestion` is null; a CONTROL asserts a `weak` row keeps its own concern and suggestion |
| AC-3 | machine | ✅ | Post-merge run on companion `7350948`: the ok / weak / unanswered rows' classNames asserted **pairwise** unequal, plus `data-verdict="unanswered"` and the reason in the row text |
| AC-4 | machine | ✅ | Same run: 1 ok + 1 weak + 1 unanswered summarises as "1 of 3 flagged" AND "1 unanswered"; a CONTROL with none unanswered asserts the word is absent |

## Why these ticks are not just a green suite

AC-1's fail state was the behaviour **in `main`**, not a hypothetical. Before the
fix, restoring `verdict: got?.verdict === 'weak' ? 'weak' : 'ok'` reddened the two
new adapter tests — so the criterion discriminates, and the passing run means the
code changed rather than the assertion being satisfiable either way.

AC-3 is asserted pairwise for the same reason. "The unanswered row exists" would
pass against a component that renders it identically to `ok`, which is precisely
the defect being fixed one layer down.

## Steps run

- `npx vitest run src/adapters/companion/ac-review.test.ts -t "unanswered"` on merged
  `main` — 3 passed
- `npx vitest run src/components/__tests__/AcGrader.test.tsx -t "TASK-1913"` on merged
  companion `main` — 3 passed
- Gates before the PRs, run bare in both repos: typecheck 0, lint 0, build 0;
  choda-deck 153 files / 2015 tests, companion 626 web + 79 electron

## Findings

The web half was **not** optional and was not in the original one-task framing:
`AcGrader` decided the border, the label colour and the summary count from
`verdict === "weak"` alone, so a third value would have rendered as approved and
"none flagged" would have printed over an ungraded criterion. The defect would
have survived the adapter fix intact, one layer up. `/choda-plan` surfaced this
by reading the consumer before splitting the task.
