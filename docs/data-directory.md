# Where the data lives — and how the packaged app loses it

Covers TASK-1510 AC-2: the manual directory-junction workaround, written down so it stops
being tribal knowledge that dies with one machine.

**This documents a workaround, not a fix.** The underlying bug (TASK-1510 AC-1/AC-3) is
still open.

## The bug in one paragraph

`resolveDataPaths()` in `src/core/paths.ts` picks a data directory and **never looks inside
it**. There is no filesystem check in that function — it is pure path arithmetic. So the
packaged app can select an empty `%APPDATA%` profile while a populated directory sits
elsewhere, come up showing nothing, and give no indication that it chose the wrong one.

Resolution order, highest priority first:

| # | Source | Who sets it |
|---|--------|-------------|
| 1 | `CHODA_DB_PATH` | legacy override; logs a warning |
| 2 | `CHODA_DATA_DIR` | the MCP server registration in `.claude.json` |
| 3 | `electronDataDir` | the packaged Electron app → `%APPDATA%\<appName>` |
| 4 | `<cwd>/data` | bare `node` runs from the repo |

The stdio MCP server passes (2) and reads the real database. The packaged app passes (3)
and gets whatever `%APPDATA%` holds. Nothing reconciles the two.

## The workaround

Point the app's `%APPDATA%` data folder at the real one with a directory junction. On this
machine:

```powershell
# Close the app first — a junction cannot replace a directory that is in use.
Remove-Item "$env:APPDATA\choda-deck-companion\data" -Recurse -Force
New-Item -ItemType Junction `
  -Path   "$env:APPDATA\choda-deck-companion\data" `
  -Target "C:\dev\choda-deck\data"
```

Verify it took:

```powershell
Get-Item "$env:APPDATA\choda-deck-companion\data" | Select-Object LinkType, Target
# LinkType Target
# -------- ------
# Junction C:\dev\choda-deck\data
```

**Before running `Remove-Item`, check what you are deleting.** If that folder already holds
a real `database\choda-deck.db`, you are about to destroy it. Move it aside instead.

### When it applies

- Every fresh install of the packaged companion app.
- Every new machine.
- After any app **rename** — the folder is keyed on the Electron app name, so a rename
  silently creates a new, empty profile (see below).

Junctions are per-machine and are not in git. Nothing re-creates this for you.

## Known casualty on this machine (recorded 2026-08-05)

Two databases exist right now. Only one is live:

| | Path | Size | Last modified |
|---|------|------|---------------|
| **Live** | `C:\dev\choda-deck\data\database\choda-deck.db` | 15,519,744 B | current |
| **Orphan** | `%APPDATA%\choda-deck\choda-deck.db` | 782,336 B | 2026-04-18 |

The orphan predates two changes: the app rename (`choda-deck` → `choda-deck-companion`) and
the data-layout migration. Its `.db` sits at the folder root rather than under `database/`,
which is the pre-migration layout — `scripts/migrate-data-layout.mjs` is what moved it. It
also holds its own `backups\choda-deck-2026-04-18.db`.

Nothing points at the orphan and nothing will. It has been dead for months. It is recorded
here because it is TASK-1510 AC-3 already realised — *"two divergent databases and no
indication which is live"* — and because an app named `choda-deck` (rather than
`choda-deck-companion`) would still find it and present April data as current.

Leave it alone unless you have confirmed the live database has everything you need. Deleting
it is safe in principle and unnecessary in practice.

## The trap this creates with backups

`backup-service` writes to `<dataDir>/backups`. If the app starts on an empty profile, the
backups it takes are backups of nothing. Take enough of them and the good ones age out of
retention. Check which `dataDir` is actually in use before trusting a backup — the orphan
above has exactly one backup, from the day it was abandoned.

## What a real fix looks like

Tracked as TASK-1510 AC-1 and AC-3:

- Before using a directory, check whether it contains a database.
- If the chosen one is empty and a plausible alternative is populated, migrate or prompt —
  never start silently blank. Silently-empty is what makes a user believe their data is gone.
- Never write into a new empty directory when a populated one exists.

AC-4 requires verifying on a **real fresh install**, not a dev run: this bug exists only in
the packaged path, so no unit test can reach it.
