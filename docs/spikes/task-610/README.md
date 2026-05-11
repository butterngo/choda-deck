# TASK-610 spike — Claude headless metrics

Frozen archive of measurement runs captured 2026-04-25 against `claude -p` headless mode. Used to inform ADR-017 (headless spawn strategy).

Source: untracked artifacts from worktree `task-610-headless-metrics-spike` (now removed). Moved here so the evidence survives the worktree cleanup without polluting `data/` (gitignored).

## Layout

- `scripts/measure-claude.ts` — driver script that produced the JSON / NDJSON files below. Run from project root with `tsx`. Not wired into `package.json` — kept for reproducibility, not for ongoing use.
- `measurements/` — one file per scenario, captured stdout of `claude -p` with timing + token-usage extracted:

| File | Scenario |
|---|---|
| `01-success.json` | baseline successful run |
| `02-warm-cache.json` | second run, prompt cache warm |
| `03-bare.json` | minimal flags, no extras |
| `04-disable-cache-claude.json` | `--cache-disabled` via Claude CLI flag |
| `05-disable-cache-anthropic.json` | cache disabled via env var route |
| `06-budget-tiny.json` | minimal token budget |
| `07-stream-json.ndjson` | `--output-format stream-json` |
| `08-resume-turn1.json` | resume session, turn 1 |
| `09-resume-turn2.json` | resume session, turn 2 |
| `10-resume-turn3.json` | resume session, turn 3 — shows token cost growing linearly per turn |
| `11-exclude-dynamic.json` | dynamic context exclusion test |
| `12-custom-syspromt.json` | custom system prompt injection |
| `13-no-persist.json` | session persistence disabled |
| `14-tool-use.ndjson` | tool-call streaming trace |

## Why this is archived, not re-runnable

The script depends on a specific `claude` CLI version + environment that was current 2026-04-25. Output shapes have since drifted (especially stream-json schema). Treat these files as historical evidence behind ADR-017 / the "don't resume" heuristic, not as a live regression suite.
