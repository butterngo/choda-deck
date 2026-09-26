# TASK-2151 — AC verification

**Task:** CLI "choda-deck activity digest": sources, git merges, file store, retention, catch-up
**Verified on:** `main` @ `ab05673` (PR #314, squash-merged, ancestry proven, CI 3/3 green)
**Session:** SESSION-1790416215546-17 · **Date:** 2026-09-26
**Result:** 8/8 AC ticked · 0 need a human · 0 blockers

## Done

| AC | Surface | Evidence |
|---|---|---|
| AC-1 | output file, runner test `AC-1:` | Two runs with different `now` give JSON identical after removing generatedAt. The test also asserts that generatedAt differs, so the comparison cannot pass vacuously. |
| AC-2 | `metrics.mergesToDefault`, runner test `AC-2:` | Temp repo, origin/HEAD → master, commits at 9/24 10:00+07, 9/25 09:00+07 and 9/25 18:00+07 give 2. A UTC window would count differently. |
| AC-3 | activity dir listing, test `AC-3:` | today−91 deleted, today−89 kept |
| AC-4 | activity dir + mtimes, test `AC-4:` | today−2 created. today−1 and today−3 keep mtime 2026-01-01 and their sentinel content. |
| AC-5 | spawned real bundle, test `AC-5:` | exit 0. The file lands under CHODA_DATA_DIR, and `<cwd>/data` does not exist. |
| AC-6 | spawned real bundle, test `AC-6:` | exit 2, and stderr names `"frobnicate"` |
| AC-7 | `dist/cli.cjs` from main, shell `time` | `activity digest --date 2026-09-25` against a copy of the real DB and the real `~/.claude`: exit 0, **7.0 s** |
| AC-8 | the AC-7 output file | prompts = 111. waitMinutes 207.1, switches 62 and unresolved 14 all equal the TASK-2150 engine values. |

## Findings

- **skippedRepos = 13 on the real machine.** Registered cwds that are not git repos (the vault, `C:\tmp\ac11-fixture`, etc.) are counted rather than failing the run. The count works as a signal. It is not an error.
- **mergesToDefault = 21 across all registered repos**, versus 15 from the 6 repos sampled during discovery. The difference comes from more repos being in scope, not from a counting change.
- **Test harness note:** the CLI loads better-sqlite3 through a dynamic `import()`, which resolves like ESM and ignores `NODE_PATH`. The spawn test therefore bundles into `node_modules/.cache/`, inside the repo tree.
- **Full-suite failures:** only documented flakes failed: mermaid (INBOX-2050/2060) and schema-version timing (INBOX-2040).

## Needs a human

None.
