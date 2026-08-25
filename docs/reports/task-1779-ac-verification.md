# TASK-1779 — AC verification

Session SESSION-1787651761303-5 · 2026-08-25 · merged as `0d170a8` (PR #255)

**5 of 6 ticked. AC-5 is not satisfied and was carried forward as TASK-1784.**
Task holds at IMPLEMENTED, not DONE.

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 list shape | ✅ | `listCommits(companion, limit:5)` → exactly 5 rows, every row non-empty sha/subject/authorDate. Route-level 200 asserted against a real temp repo. |
| AC-2 taskIds both ways | ✅ | `9dfe9c4 …(TASK-1767)` → `["TASK-1767"]`; `ad39672 chore(release): 0.8.0 …` → `[]` **and still present**. Both halves. |
| AC-3 non-repo → 409 | ✅ | Real temp non-repo dir → 409 with cwd, no `commits` key. Control: real repo → 200 non-empty. Injecting `catch { return '' }` reddened exactly these 2 tests (diff-confirmed). |
| AC-4 stat matches git | ✅ | `0d170a8` → 4 files `+25/-1, +13/-0, +398/-0, +375/-0`; `git show --numstat` by hand returns 25/1, 13/0, 398/0, 375/0. Every number. |
| AC-5 orphan sha → 404 | ❌ **NOT DONE** | See below. |
| AC-6 timing | ✅ | 100 commits on the 541-commit repo, 5 runs post-warm-up: 59.4 / 61.4 / 58.7 / 58.2 / 61.7 ms → **median 59.4 ms**. Detail 118.5 ms. Bar was 1000 ms. |

## AC-5 — why it is unticked

The criterion said a sha recorded in a session handoff that is not on main returns 404. Measured against the real companion repo for `bf781db`:

```
git cat-file -e 'bf781db^{commit}'                → exit 0    object still present
git branch -a --contains bf781db                  → empty     reachable from NO ref
git merge-base --is-ancestor bf781db origin/main  → false     not on main
git log -1 bf781db → "test(web): a route with no inbound link… (TASK-1767)"
```

The route returns **200**, because `hasCommit` asks `cat-file -e` — *"is this object in the database"* — and a pre-squash object survives until `git gc`.

**The criterion did not fail; the contract behind it was wrong.** And the resulting behaviour is worse than either answer alone because it is machine-dependent: 200 on the laptop that made the branch, 404 on a fresh clone, with nothing saying which you are looking at.

The suite passes AC-5 honestly in a *temp* repo where `bf781db` genuinely does not exist. The gap only shows against a real repo carrying its own orphans — which is where the audit view will run.

Filed as **TASK-1784** with a four-state `reachability` field (`default-branch` / `branch-only` / `unreachable` / `absent`) rather than reworded here.

## Blockers / needs a human

None. Every criterion on this task is machine-class; nothing was left for a person.

## Findings worth carrying

1. **`cat-file -e` answers a different question than "does this commit exist for the reader."** Object presence is local and temporary; reachability is the property an audit surface actually means.
2. **A temp-repo fixture cannot catch an orphan bug** — the fixture has no history to orphan. Both were needed: unit tests on a temp repo for parsing, and a live read of a real repo for AC-5, which is the only place the gap appeared.
3. **The wiring tests earned their place.** Removing the route registration reddened exactly the two `http-server` tests and nothing else. Per the recalled TASK-1748 memory, 16 green unit tests once coexisted with a route that 500'd for every task.

## Gates

typecheck 0 · full suite 136 files / 1703 tests 0 (+35) · lint 0 · build 0 (mcp + cli + companion)
CI on PR #255: ubuntu, windows, docker-image — all pass.
Merge proven: `0d170a8` is an ancestor of `origin/main`.
