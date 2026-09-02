---
task: TASK-1797
title: "Adapter: GET /workspace-symbols — scan a workspace for a symbol's definition"
session: SESSION-1788338468895-5
date: 2026-09-02
verdict: 8/8 verified · 0 needing a human · 0 blocked
---

# AC verification — TASK-1797

Merge proven: `286dbe9` is an ancestor of `origin/main` (PR #260, squash).
All 8 criteria are machine-class; none needed a human, so none was left unticked.

## Done

| AC | Criterion | Proven by | Discriminator — how a wrong build fails |
|---|---|---|---|
| 1 | The real symbol resolves to path + line + kind | **LIVE** scan of `C:/dev/test/bpa-engine` → `src/BpaEngine/Api/Auth/ServiceTokenAuth.cs:138`, kind `class` | A response naming any other line fails; removing the anchor empties `kind` |
| 2 | Unknown name → 200 + `[]`, never 404 | Route test + live control (`control_zero=[]` while the real name returned one match) | An implementation always returning `[]` fails the paired non-empty control |
| 3 | Call sites and comments are not declarations | Fixture `src/Endpoints.cs` holds both a comment mention and the requirement's own `.AddEndpointFilter<...>()` line, and is absent | Injection: dropping the keyword anchor turns exactly this test red |
| 4 | Missing/blank name → 400 and no walk | Three URLs against a `getWorkspace` spy asserting `lookups === 0` | A build that validated after the lookup passes the status check but fails the counter |
| 5 | Unknown workspace → 404 whose body names it | Asserts `error === 'unknown workspace: ghost'` **and** `error !== 'not found'` | Collapsing to the router's generic body fails the second assertion |
| 6 | No token → 401 with no data; non-GET → 405 | Tokenless request asserted to carry no `matches` property | A 401 that still leaked the array fails |
| 7 | Missing cwd → 409 naming workspaceId, label, cwd | `toMatchObject` on all three fields, not just the status | A bare 409 fails |
| 8 | A binary whose bytes contain the name is skipped | Fixture writes a PNG header concatenated with the literal text `class ServiceTokenWorkspaceFilter` | A scan decoding binaries as utf8 WOULD match it, and fails |

## Needs a human

None. Every criterion was machine-class, which is why this task was eligible for
an unattended run in the first place.

## Findings worth carrying

**The NFR holds warm and misses cold.** The task body promised < 1s, citing
0.10-0.17s. Measured against the real bpa-engine checkout:

| | |
|---|---|
| cold first scan | 6,296 ms |
| warm runs (3 consecutive) | 64 / 59 / 62 ms |
| tree | 1,328 files, 524 of them text, 9.8 MB |

The original 0.17s figure came from `grep --include=*.cs`, which reads only C#
files; this implementation reads every text file. That is a real difference, not
measurement noise, and the cold number exceeds the stated NFR. No acceptance
criterion constrains timing, so nothing here is a failed AC — but a reader who
trusts the body's "< 1s" without this note would be misled on first use.

**The pre-existing worker-fork flake recurred.** The local full suite reported
`1761 passed, 0 failed` with one file dropped to `[vitest-pool]: Worker forks
emitted error` — the flake documented in INBOX-1891 (varies between runs,
unrelated files, CI unaffected). All 3 CI checks passed, including
`windows-latest`, which is consistent with that entry's finding that the flake is
local to this machine.

## Steps a human can repeat

1. `pnpm run typecheck` · `pnpm test` · `pnpm run lint` · `pnpm run build` — all bare, all exit 0 (the suite's exit 1 is the INBOX-1891 flake, with zero failed tests).
2. `npx vitest run src/adapters/companion/workspace-symbols.test.ts` — 17 passed.
3. Injection: replace the body of `definitionPattern` with a bare `\b${name}\b` and re-run — exactly 5 tests go red, 12 stay green.
