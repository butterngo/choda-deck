# TASK-1516 — Windows CI SQLite timeouts: diagnosis and fix

**Session:** SESSION-1785672435582-55 · **Date:** 2026-08-02

**Root cause: `initSchema` ran ~128 unwrapped `db.exec()` calls against a database in
SQLite's default rollback-journal mode.** Every one of those is its own implicit
transaction — create a journal file, write, fsync, write the db, fsync, delete the
journal. On NTFS with antivirus watching file creation that is far more expensive than
on ext4, which is exactly why Windows CI failed while Linux never did.

Not runner contention, though contention is what turned a slow operation into a red
build. AC-1 asked which it was, and the answer is that the operation was pathological to
begin with.

---

## Observed distribution (AC-4)

### Outcome across the six PRs merged 2026-08-01/02

| PR | ubuntu | windows |
|----|--------|---------|
| #230 | pass | **FAIL** |
| #231 | pass | pass (5m12s) |
| #232 | pass | pass (5m06s) |
| #233 | pass | pass (5m22s) |
| #234 | pass | **FAIL** (10m46s) |
| #235 | pass | **FAIL** (5m16s) |

**3 of 6 red on Windows, 0 of 6 on Linux.** Even when green, Windows took ~5 minutes
against ubuntu's ~1m15s.

### Failing tests, and the discriminator

| Test file | Sets `journal_mode = WAL`? | Ever failed? |
|---|---|---|
| `sync-actions.test.ts` | no | yes |
| `knowledge-service.test.ts` | no | yes |
| `agent-memory-repository.test.ts` | no | yes |
| `schema-version.test.ts` | no | yes |
| `code-ref-repository.test.ts` | **yes** | no |
| `relationship-repository.test.ts` | **yes** | no |
| `embedding-store.test.ts` | **yes** | no |
| `knowledge-search.test.ts` | **yes** | no |

A clean split. Every failure was a file that let SQLite keep its default journal mode;
no file that set WAL has ever appeared in a failure list. 18 test files call
`initSchema` without setting WAL — that was the exposed surface.

Failures were **always timeouts, never assertion failures**: `Test timed out in 15000ms`
and `Hook timed out in 30000ms`, at 27s / 39s / 44s against a 15s cap.

### Measured cost of `initSchema` on a fresh database

Local dev machine, idle, median of 5 runs:

| Journal mode | Median | vs default |
|---|---|---|
| default (rollback journal) | **412 ms** | — |
| `journal_mode = WAL` | **11 ms** | **38.5× faster** |
| `WAL` + `synchronous = OFF` | 9 ms | 46.8× |
| `synchronous = OFF` only | 83 ms | 5.0× |

The 38× gap on idle hardware matches the ~37× overshoot AC-1 noted from CI. Contention
multiplies it; it does not cause it.

### End-to-end, the four files that failed on Windows

| | Result |
|---|---|
| **With WAL** | 59 tests, 4 files — **3.1 s** |
| **Without WAL** | **timed out at 10 minutes, never finished** |

On a fast local machine with nothing else running. The per-call 412 ms compounds because
each file calls `initSchema` 2–7 times across its cases.

Whole suite also improved: **~50 s → ~32 s** wall for 127 files.

---

## The fix (AC-2)

One line, in `initSchema` itself:

```ts
function ensureWal(db: Database.Database): void {
  try {
    db.pragma('journal_mode = WAL')
  } catch {
    /* read-only handle or a filesystem that refuses WAL */
  }
}
```

**Why there and not in the test files.** 18 files would need editing and every future
test would need to remember. `initSchema` is the thing that is slow, so it is the thing
that should declare its requirement.

**Why this is a no-op for production.** `SqliteTaskService` already sets
`journal_mode = WAL` immediately before calling `initSchema`. The CLI and companion sync
paths open the production database, which is already WAL on disk (the mode is persistent).
So no production database changes mode; the line makes an existing requirement explicit
instead of relying on each caller to remember it.

**Why WAL and not `synchronous = OFF`.** Turning off synchronous trades durability for
speed and would apply to production too. WAL keeps durability, and is faster anyway.

**Why not scoped to CI**, as AC-2 allowed for. Scoping a timeout raise to Windows would
have been the tuning answer, and AC-1 explicitly warned against it before diagnosing. The
timeouts stay at 15 s / 30 s: a test that now exceeds them has a real problem.
Fixing the cause rather than the symptom means Linux gets the speedup too.

**Degrades rather than throws.** SQLite refuses WAL on network filesystems and for
in-memory databases, returning the unchanged mode instead of raising — so a cross-mount
deployment (TASK-780) keeps working, just without the speedup. Covered by a test.

---

## On AC-3 — intermittent red must stop being routine

Three reds in one session, each requiring a log to be read before it could be dismissed.
The behavioural cost AC-3 names was visible in this very session: the standing question
became "is this the flake?" rather than "what broke?", and the honest answer needed
several minutes of log-reading every time. Twice the answer was reached by checking that
zero assertion failures were present and that the failing files were untouched by the
diff — a procedure, not an intuition, and precisely the sort of thing that erodes when
people are busy.

This fix removes the cause. What it does not do is prove the runner will never again be
slow enough to trip a 15 s cap under some other load, so the correct follow-up is to
watch whether Windows goes green consistently over the next several PRs rather than
declaring the class closed after one.

---

## Guard against regression

Three tests in `schema-version.test.ts`:

- a file-backed database is left in WAL mode after `initSchema`
- `initSchema` completes in under 100 ms — deliberately loose (10× the WAL median, still
  4× under the rollback-journal median) so it fires on a real regression to non-WAL
  without flaking on slow hardware
- an in-memory database does not throw, covering the graceful-degradation path
