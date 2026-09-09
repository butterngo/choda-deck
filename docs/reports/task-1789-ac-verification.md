---
task: TASK-1789
title: Syntax highlighting in the file viewer — C#, SQL, JS, CSS and the rest
verified: 2026-09-09
session: SESSION-1788921332028-109
note: verified retroactively — shipped in companion #80; one criterion had no test and it was written today
---

# AC verification — TASK-1789

**Done: 8/8. Needs a human: none. Blockers: none.**

The feature shipped in `9afa820` (companion #80) on 2026-08-26 and the record
never closed. Seven criteria had tests to read. **AC-3 had none**, so it was
written and merged today as #130 (`609586f`) — both proven ancestors of
`origin/main`.

## Criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | ✅ | "colours a C# file" + CONTROL "a `.txt` renders with no highlight markup at all". The suite deliberately does **not** mock highlight.js — a mock would prove the wiring calls something, not that a `.cs` colours |
| AC-2 | ✅ | Zero loads for a file with no language + CONTROL "a `.cs` DOES reach it, once per line" |
| AC-3 | ✅ | **Written today** — see below |
| AC-4 | ✅ | The extension list walked, with `null` for nothing-to-highlight as the control and `Dockerfile` (no extension) as a third case |
| AC-5 | ✅ | "maps `.cshtml` to markup, **and says so rather than pretending it is C#**" — the accepted Razor gap pinned by a test named after the pretence it forbids |
| AC-6 | ✅ | Text survives a failed highlight, text shows before any grammar arrives, and markup from the FILE is escaped |
| AC-7 | ✅ | Read at the stylesheet — see the limit below |
| AC-8 | ✅ | `#80`'s commit message records "Main bundle 584.27 -> 594.51 kB (+10.24 kB, wiring only)" |

## AC-3 — the criterion that had no test, and why the obvious test would have lied

> Opening two different `.ts` files loads the typescript module **once**, not
> twice. Fail: the count scales with files opened.

The guard is real: `registered` in `lib/highlight.ts`, whose comment promises the
core is *"loaded at most once for the life of the page"*. Nothing observed it, so
a refactor dropping the Set would have shipped green.

Finding the observation point was the work:

* `LOADERS` is module-internal — the loader cannot be spied.
* **A factory counter on the language module cannot discriminate.** The module
  registry caches the module, so the factory runs once whether `load()` is called
  once or ten times. That test passes in both worlds and proves nothing — the
  exact shape this project keeps finding.
* `mod.default` is read once per `load()`. A proxy counting that read separates
  *loaded once* from *loaded per file*.

Two tests, because one is not evidence: two `.ts` files hold the count at 1, and
a CONTROL that clears the cache drives it to 2 — which is what shows the counter
is live rather than stuck.

**Injection:** replacing the guard with `if (true)` reddens the first with
`expected 2 to be 1`, the control staying green.

## AC-7 — proven by reading, with the limit stated

`index.css` carries 34 light `hljs` rules and 32 `.dark .hljs-*` overrides. The
two without a dark counterpart are `.hljs-emphasis` (`font-style: italic`) and
`.hljs-strong` (`font-weight: 600`) — no colour, so none needed. The base surface
sets background and colour in both.

Every token carrying a colour is defined in both themes, so the AC's fail state —
*a stylesheet that only defines one theme* — does not hold.

**The limit:** no automated test asserts this. A future edit could delete a dark
rule and nothing would go red. The criterion is satisfied today by reading the
artifact, not by a guard.

## AC-8 — why it had to be recorded then, not measured now

The main bundle today is **1,000.07 kB**, grown by features that landed after
this one. The criterion is satisfied because the number was captured in the
commit message at the time; had it not been, it would be unrecoverable now.

## Findings

This is the fourth of four Files/audit records closed today, and the run turned
up a **fifth**: TASK-1792 shipped in companion #82 (`dab4735`) — the per-line
highlighting this task's own test comments describe as already done — and is
still sitting in TODO. TASK-1786 (#83) looks the same. Neither was in this run's
scope, and neither has been verified.
