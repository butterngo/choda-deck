# TASK-2150 — AC verification

**Task:** Activity digest engine: transcript + history rows to daily metrics (pure functions)
**Verified on:** `main` @ `89c362e` (PR #313, squash-merged, ancestry proven)
**Session:** SESSION-1790414291260-9 · **Date:** 2026-09-26
**Result:** 6/6 AC ticked · 0 need a human · 0 blockers

## Done

| AC | Surface | Evidence | Discriminator |
|---|---|---|---|
| AC-1 | `computeTranscriptDigest` return, test `AC-1:` | 1 test run in isolation (`-t "AC-1:"`), passed | UTC bucketing returns prompts = 0 for 2026-09-25 |
| AC-2 | same, test `AC-2:` | passed: badRows = 1, unknownTypes = 1, prompts = 1 | an impl that skips bad lines silently (like `parseTranscript`) reports badRows = 0 |
| AC-3 | same, test `AC-3:` | passed: prompts = 0, toolMix.Bash = 1 | counting sidechain rows gives prompts = 1; skipping sidechains entirely gives Bash undefined |
| AC-4 | same, test `AC-4:` | passed: 2 turns, rate 0.67 | a prefix match would also count "fix…" only if it started with y/ok; the whole-prompt anchor is what yields 2 |
| AC-5 | same, test `AC-5:` | passed: run = 11, wait = 1 | ignoring cross-session overlap gives wait = 11 |
| AC-6 | same, test `AC-6:` | passed: switches = 1, unresolved = 1 | raw-cwd comparison gives switches = 2 |

## Cross-check against real data (independent of the tests)

The merged engine was bundled and run on the real 2026-09-25 transcripts (35 files, 7,279 rows in the day). It completed in 352 ms. Its results were compared with the discovery prototype (`docs/reports/activity-recorder-daily-diagnosis-discovery.md` Round 4, in choda-deck-companion), which was written independently before this code existed:

| Metric | Engine | Prototype |
|---|---|---|
| prompts | 111 | 111 |
| confirmationTurns | 9 | 9 |
| claudeRunMinutes | 356.1 | 356 |
| waitMinutes | 207.1 | 207 |
| activeMinutes | 460 | 460 |
| projectSwitches | 62 | 62 |
| unresolvedPrompts | 14 | 14 |

## Findings

- **Windows CI flake, not caused by this change.** `pty-session.test.ts` failed on the windows-latest runner (node-pty "AttachConsole failed"). A rerun of the same commit passed. Filed as INBOX-2106.
- **Local full-suite flake, already documented.** `mermaid-check.test.ts` and `workspace-diagram.test.ts` timed out under full-suite load (INBOX-2050/2060). Run alone, they pass 29/29.
- **unknownTypes is large on real data** (2,451 of 7,279 rows are attachment/system/etc.). This is by design, since the count is a drift signal rather than an error. The skill (TASK-2154) should compare it day over day, not read it as an absolute value.

## Needs a human

None.
