---
type: decision
title: "ADR-012: SQLite daily backup + restore — atomic, retained 7 days"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-04-17
lastVerifiedAt: 2026-04-29
---

# ADR-012: SQLite daily backup + restore — atomic, retained 7 days

## Context

ADR-007 (Risks §) originally mitigated SQLite corruption with *".md files as backup, git versioning"*. ADR-010 then removed .md export for conversations (SQLite-only protocol). Follow-on effect: `sessions`, `conversations`, `inbox`, and all task/phase/feature data now live **only** inside `choda-deck.db`. There is currently no backup mechanism. One corruption event = full data loss.

Constraints shaping the design:

- `better-sqlite3` is the driver; it supports `VACUUM INTO`, `db.backup()`, and raw file copy while open.
- Electron main process owns the DB at `app.getPath('userData')/choda-deck.db`. Renderer never touches it.
- The app has no background scheduler yet — adding a cron-style worker just for backup would be premature infrastructure.
- DB is small by design (single-user, low hundreds of thousands of rows ceiling). Incremental strategies are overkill.
- Linked ADRs: [ADR-007](./ADR-007-choda-deck-replaces-obsidian.md), [ADR-010](./ADR-010-conversation-protocol.md), [ADR-004](./ADR-004-sqlite-task-management.md).

## Decision

Ship a **local-only, app-start-triggered** backup with `VACUUM INTO`, 7-day rotation, and a Settings UI for restore.

### Trigger — on app start, 24h gate

On `app.whenReady()`, after DB init:

```ts
if (Date.now() - lastBackupMtime() >= 24 * 60 * 60 * 1000) {
  runBackup();
}
```

Chosen over `setInterval` cron and manual-only. Butter opens the app at least daily; a start-time check is deterministic, has zero long-lived state, and survives sleep/wake trivially.

### Format — `VACUUM INTO`

```sql
VACUUM INTO '<backupPath>';
```

Single statement, atomic snapshot, compacts the output, reuses the open connection. `better-sqlite3` runs it synchronously; write-lock duration is negligible for a single-user local DB. Preferred over `fs.copyFile` (torn-file risk mid-write) and `db.backup()` (online API — more code for no benefit here).

### Location

```
<app.getPath('userData')>/backups/choda-deck-YYYY-MM-DD.db
```

Same roaming scope as the live DB. Excluded from the app bundle. Survives app updates.

### Retention — 7 daily rolling

After each successful backup, prune any `.db` in the backup folder older than the 7 most recent. One backup per calendar day (overwrite if same date). Covers the "broke it yesterday, noticed today" window without unbounded growth.

### Restore — Settings panel, manual, explicit

1. Settings → **Backups** section lists files (date + size, newest first).
2. Click **Restore** on a row → confirm dialog: *"Replace current data with this backup? The app will restart."*
3. On confirm, main process:
   1. Closes the DB connection.
   2. `fs.copyFileSync(backupPath, dbPath)`.
   3. `app.relaunch(); app.exit(0)`.

No in-place preview, no selective table restore, no merge — all out of scope for MVP.

## Rationale

- **KISS over clever.** `VACUUM INTO` + a 24h gate + 7 files is ~50 lines of code. No scheduler, no IPC choreography, no new dependencies.
- **Restores the ADR-007 safety net** that ADR-010 implicitly removed. Keeps the SQLite-only protocol of ADR-010 intact — backup is the fallback, not dual-writes.
- **Filesystem is the UI.** Date-named files in `userData/backups/` are legible, zippable, git-able, Dropbox-able — no extra surface area required to give Butter recovery options beyond the in-app button.

## Consequences

### Positive

- First corruption / bad migration / accidental mass-delete is recoverable with one click.
- Backups are plain SQLite files — inspectable with any sqlite client, portable, manually restorable without the app.
- Zero new long-lived processes; nothing to monitor.

### Negative

- A crash in the narrow `VACUUM INTO` window could leave a partial file — mitigated because `VACUUM INTO` is atomic (either target exists complete or not at all). Worst case: the day's backup is missing, yesterday's remains.
- App-start-only trigger means a session longer than 24h won't take a mid-run snapshot. Acceptable — Butter's usage pattern is multiple short sessions per day.
- Restore requires app restart. Acceptable for a single-user tool; the alternative (hot-swap connections) is complex and error-prone.

### Out of scope (deferred)

- Cloud sync / remote backup (later: point `userData/backups/` at a git remote or cloud drive).
- Incremental snapshots or WAL archiving.
- Encrypted backups (same trust boundary as the DB).
- Auto-restore on corruption detection.
- Named / tagged backups.

## Open questions

- Should we also trigger a backup **before** running any future schema migration? (Proposed: yes, as a migration-runner concern — outside this ADR.)
- Expose a "Backup now" button next to the list for paranoid manual snapshots? (Cheap to add — include in the task.)
