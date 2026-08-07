# TASK-1601 — AC verification

**Task:** Adapter · vault link index for backlinks (`GET /vault/links`)
**Session:** SESSION-1786097598449-22
**PR:** [#248](https://github.com/butterngo/choda-deck/pull/248) — squash-merged as `ad35d96`
**Merge proof:** `git merge-base --is-ancestor ad35d96b5a77a0115e91600ade61a3dfeb7fc450 origin/main` → ancestor ✅
**CI:** 3/3 green — ubuntu 1m6s, windows 1m49s, docker-image 44s

**Result: 4/4 verified · 0 blocked · 0 needing a human.**

## Criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | 200, object mapping each slug to `{outgoing, incoming}` | ✅ | *"maps every note slug to outgoing + incoming"* — status 200, all three fixture slugs present with array-typed fields |
| 2 | Symmetric relation | ✅ | *"is symmetric across every resolvable link"* iterates the **whole payload**; an implementation filling `outgoing` and leaving `incoming` empty fails it |
| 3 | Dangling link reported, no entry invented | ✅ | *"reports a dangling link without inventing a note for it"* — `does-not-exist` is in `outgoing` and absent from `Object.keys` |
| 4 | Token-gated exactly like `/vault/notes` → 401 | ✅* | *"requires the bridge token"* — 401 for both missing and wrong. **See the wording defect below** |

## AC-4 named the wrong header

The criterion's parenthetical said *"an absent or wrong `authorization`
header returns 401"*. **The companion adapter has no `authorization` header.**
Every route is gated on `x-choda-bridge-token` via `tokenMatches`.

This was found in the §4 research pass — *after* `session_start` had locked the
body, so the wording could not be fixed in place. Handling, per burn-down §12
(never silently redefine an AC to make it pass):

- The route was implemented against the **real** gate, mirroring its siblings.
- The criterion's actual requirement — "token-gated exactly like
  `/vault/notes`" — is genuinely met and is what was ticked.
- The defect is recorded in the tick's evidence string, here, and as
  **TASK-1606**.

The tempting wrong move was available and rejected: adding `authorization`
support to the adapter would have made the AC pass literally while widening
the auth surface for no reason.

**Correction to the record:** the AC-4 evidence string predicts this follow-up
would be "TASK-1605". The created id is **TASK-1606**. The evidence string is
immutable once ticked; this line is the correction.

## One existing assertion changed

Adding the `note-linker` fixture to the shared `30-Knowledge` root broke
AC-1's slug assertion in `vault.test.ts`, which pinned exactly two `.md`
files. Updated to pin three.

This is a fixture addition, not a loosened test: the assertion still pins the
**exact** set, so the `.txt`-exclusion it guards is unweakened. Flagging it
because "a test needed editing" is normally the signal to stop and reassess —
here the cause was traced to the fixture, not to behaviour.

The alternative (an isolated vault + second server for the links tests) was
considered and rejected as ~25 lines of boilerplate to avoid a one-line
assertion update whose meaning is preserved.

## Design notes

| Decision | Reasoning |
|---|---|
| Dangling target gets no key | Reporting the link is useful; inventing a note for it is not. Makes AC-2's symmetry necessarily scoped to resolvable targets |
| `[[a\|alias]]` / `[[a#heading]]` collapse to `a` | Otherwise an aliased link reads as dangling — the regex stops the capture at `\|` and `#` |
| Unreadable note still gets an entry | Stays a valid backlink target; same rule `listNotes` already applies |
| Scan per request, no cache | ~50 notes is milliseconds, and a cache would need invalidating against a hand-edited directory |
| Scope unchanged | Serves `30-Knowledge` only. Whether that scope should widen is **TASK-1600**'s decision, deliberately independent of this route |

## Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | 1624 passed, 133/133 files (1619 + 5 new) |
| `npm run lint` | pass |
| `npm run build` | `companion-server.cjs` 481.2kb |

## Follow-ups

- **TASK-1606** (created) — the `authorization`-header planning defect, which
  also affects TASK-1599's Test Plan.
