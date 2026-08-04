# Autonomous task-burn loop — best practices

Distilled from running four Companion tasks (TASK-1173, TASK-1172, TASK-1174,
TASK-1157) end-to-end, unattended: discover → session-start → implement → test
→ PR → CI → merge → session-end → next task, repeated until the backlog was
clear. Written for a future skill that wants to automate this cycle.

## The loop shape that worked

```
discover open tasks (task_list, labels filter, topo by blockedBy)
  → for each unblocked task:
      session-start (branch, session_start)
      research existing patterns before writing code (Explore agent, read-only)
      implement + colocated tests, mirroring an existing sibling file 1:1
      typecheck + lint + build + full test suite, all must exit 0
      commit (scoped `git add` — never `git add -A` blind)
      push + gh pr create
      gh pr checks --watch (if CI configured) OR verify no checks exist
      gh pr merge --squash --delete-branch
      verify merge-base --is-ancestor <mergeCommit> origin/<default>  ← do this, don't trust PR state
      session-end (ac_check each item with real evidence, session_end, task_update → DONE)
      prune branch (switch main, pull --ff-only, branch -D, fetch --prune)
  → repeat until no open tasks remain
  → write this file
```

## What made each step reliable

### Discovery
- Filter `task_list` by the project's own label (e.g. `companion`) across
  `TODO`/`READY`/`IN-PROGRESS` — cheaper and more precise than paging the whole
  backlog.
- Respect `blockedBy` before starting a task. A task whose blockers are still
  open will 400 or produce broken code that references endpoints that don't
  exist yet. Check each blocker's `status` via `task_context`, not just its id.
- A parent "epic" task with all subtasks IMPLEMENTED/DONE can itself go
  straight to DONE via `task_update` — no branch, no session needed, since
  there's no independent code to write. `task_update` itself enforces the
  blocker gate (`status=DONE is hard-blocked if any subtask ... not
  IMPLEMENTED/DONE/CANCELLED`), so this is safe to call directly.

### Cross-repo tasks
- A single "Companion" feature can span two repos (here: `choda-deck` for the
  backend adapter, `choda-deck-companion` for the frontend). Match the task's
  `cwd` against `project_list`'s registered workspaces *before* branching —
  don't assume the workspace from the previous task carries over.
- When switching repos mid-loop, re-check `git status --porcelain` — a repo
  can carry **pre-existing unrelated dirty state** from an earlier, unrelated
  session (e.g. a stale `docs/knowledge/INDEX.md` regen). Branching in place
  is safe (uncommitted changes carry forward, nothing is lost), but **stage
  files by explicit path**, never `git add -A`, so the commit doesn't
  silently absorb someone else's in-flight work.

### Research before code
- Spend one read-only research pass (Explore agent or direct Grep/Read) on
  the *sibling* implementation before writing anything: the existing
  hook/component/route pattern in this codebase is the actual spec. Copying
  an established shape (query-hook signature, confirm-gate mutation pattern,
  error-surfacing convention) beats inventing a new one — and keeps
  lint/typecheck green on the first try.
- Explicitly ask the research pass to report **exact response shapes** (field
  names, nullability) for any endpoint you'll consume — guessing a shape and
  discovering the mismatch at typecheck time costs a full round-trip.

### Interface-widening judgment call
- Sometimes the cleanest implementation requires widening a shared interface
  (here: adding `RelationshipOperations` to `BackendTaskService` so the new
  route didn't need an `as unknown as` cast). This is safe when **every
  concrete implementer already satisfies the interface at runtime** — verify
  with a grep for the methods on each concrete class before doing it, and say
  so in the commit message so a reviewer doesn't have to re-derive it.

### Test-writing pattern
- Reuse the exact fixture/fake-service shape from an existing test file in
  the same adapter (e.g. `workflow.test.ts`'s `fixtureDb()` +
  `fakeWorkflowSvc()` pattern) rather than inventing a new fixture builder.
  Cuts both the time to write it and the risk of a subtly-wrong fake.
- `fireEvent.click`/`fireEvent.change` over raw `.click()`/`.value =` in
  React Testing Library — raw DOM mutation skips React's event system and
  produces `not wrapped in act(...)` warnings even when the assertions still
  pass. Warnings are a signal the test doesn't model a real user interaction;
  fix them, don't ignore them.
- Match an endpoint's actual degrade-gracefully contract in tests. E.g. a
  search endpoint that returns `{enabled:false, reason}` on a disabled
  provider should never be tested via a thrown error — assert the pass-through
  shape instead, matching what the adapter test already proved as truth.

### Verification gates (in order, each one blocking)
1. `typecheck` — catches shape mismatches immediately, cheapest signal.
2. Full test suite in isolation for the new file, then the whole suite — a
   known environment-flake (e.g. a documented worker-fork "Errors: 2" or a
   Windows CI SQLite timeout) is fine to note and move past; a new,
   unexplained failure is not.
3. `lint` — run it, don't assume typecheck implies lint-clean (unused-var
   rules, etc. are lint-only).
4. `build` — the actual artifact a browser/consumer would load; typecheck can
   pass while `vite build`'s stricter resolution still fails.

Piping a gating command through `tail`/`grep` hides its exit code — a
downstream `&&` sees the pipe's exit status, not the gated command's. Run
gating commands bare.

### PR + CI + merge
- Check whether the repo has CI wired at all
  (`gh pr view --json statusCheckRollup`) before assuming a watch will ever
  resolve — some repos in this environment have zero required checks, and
  `gh pr checks --watch` on such a branch returns instantly with "no checks
  reported," which is a valid all-clear, not a failure.
- When CI *is* configured, watch to completion (`gh pr checks --watch
  --interval 20`) and only merge on all-green. Do not `--auto`-merge on a repo
  with no required checks — it can land before a slow job finishes; watch
  explicitly instead.
- **Never trust "PR state: MERGED" as merge proof for closing a task.**
  Squash/rebase merges rewrite the SHA, so `git log` on the local branch tip
  won't be an ancestor of the merge commit. The one correct check:
  ```
  MC=$(gh pr view <n> --json mergeCommit -q .mergeCommit.oid)
  git merge-base --is-ancestor "$MC" origin/<default-branch>
  ```
  Do this before ticking any AC or before `session_end` marks the task DONE.

### Session close discipline
- `ac_check` each acceptance item individually with a *specific* evidence
  string (a test file name + pass count, a literal command + exit code) —
  never a blanket "done." This is what a future reader (human or agent) uses
  to trust the close without re-verifying the code.
- `session_end` in this system sets the task to **IMPLEMENTED**, not DONE —
  DONE is a separate, deliberate `task_update` step gated on the merge proof
  above. Don't skip that second call; a task stuck at IMPLEMENTED forever
  looks unfinished to any future focus/planning tool.
- Classify loose ends honestly before writing them: a concrete follow-up with
  a clear owner is a `task_create`, not a `looseEnds` entry — `looseEnds`
  becomes an inbox item, which is the right bucket only for a genuine open
  question needing research (e.g. "the adapter has no workspace-enumeration
  endpoint" — a real gap, not yet actionable enough to be its own task).
- After a proven merge, always prune: `switch <default>`, `pull --ff-only`,
  `branch -D <feature>` (squash merges need `-D`, not `-d` — the branch tip is
  never a content-ancestor of a squash commit even though the PR *is* merged),
  `fetch --prune`.

## What to automate vs. keep a human in the loop for

Automatable safely, in order of confidence:
- Discovery + dependency ordering.
- Research pass before implementation (read-only, no risk).
- Implementation + test-writing, when a sibling pattern exists to mirror.
- All four verification gates (typecheck/test/lint/build).
- Commit with a scoped `git add` (never blind `-A`).
- PR creation, CI watch, merge-on-green, branch pruning.
- AC-ticking with real evidence, session_end, DONE promotion — all
  deterministic given the merge-proof check above.

Needs an explicit human opt-in per run (this session required both, up
front, before starting):
- **Auto-merge without a per-PR pause.** Merging is a shared-state,
  hard-to-reverse action; get one confirmation for "merge every green PR in
  this run," not zero.
- **Loop pacing.** A fixed short interval (e.g. "every 5 minutes") does not
  fit a full task cycle — self-paced/dynamic scheduling that resumes after
  each task completes is the correct shape, not a timer.

Still requires stopping and asking, even mid-autonomous-run:
- A dirty working tree with unfamiliar changes not caused by this run.
- A task whose blockers are NOT satisfied (don't silently skip or
  reinterpret scope).
- A gap discovered mid-implementation that changes the task's contract
  (e.g. "the endpoint this AC depends on doesn't support the parameter the
  spec assumes") — implement the honest workaround, document it as a loose
  end, but don't silently redefine the AC to make it "pass."
