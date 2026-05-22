# PostToolUse hook — file-edit telemetry (ADR-029 channel 1)

Records every `Edit / Write / MultiEdit` operation as a `kind='file_modified'`
observation on the active session's `session_events`. Per-developer opt-in;
without it, channels 2 + 3 (`ac_check` + `session_end` summary) still work —
only file-edit telemetry is missing.

## Install

Add the block below to `~/.claude/settings.json` (merge with existing hooks
config if present):

```jsonc
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node C:\\dev\\choda-deck\\scripts\\hooks\\file-edit-event.mjs"
          }
        ]
      }
    ]
  }
}
```

Adjust the path for your platform: on macOS / Linux use
`node /path/to/choda-deck/scripts/hooks/file-edit-event.mjs`.

Restart Claude Code (or `claude --reload`) so it picks up the new hook block.

## Verify the script in isolation

The script ships with a `--self-test` mode that builds a throwaway SQLite DB,
fires synthetic `Edit` / `Write` / `MultiEdit` inputs, and asserts a
`file_modified` row landed for each:

```bash
node scripts/hooks/file-edit-event.mjs --self-test
# expected: "[self-test] OK — 3 file_modified events landed (Edit, Write, MultiEdit)"
```

## End-to-end smoke (after install)

1. Open Claude Code in a workspace registered with choda-deck (any folder
   matched by a row in the `workspaces` table — `workspace_list` shows them).
2. Start a session via the MCP `session_start` tool. The hook reads
   `cwd` from each tool call and matches it against registered workspace
   `cwd` prefixes (longest-prefix wins for nested repos).
3. Have Claude do a real `Edit` / `Write` on any file inside the workspace.
4. From a separate shell:

   ```bash
   sqlite3 "$CHODA_DATA_DIR/database/choda-deck.db" \
     "SELECT id, payload_json FROM session_events
        WHERE event_type='observation'
        AND json_extract(payload_json,'\$.kind')='file_modified'
        ORDER BY id DESC LIMIT 3;"
   ```

   Or via MCP: `session_event_list` against the active `sessionId`.

   Expect one new row per modified file with payload shape
   `{kind:'file_modified', path, linesAdded, linesRemoved, tool}`.

## Negative smoke

Fire the hook while **no** session is active for the workspace (just close
the session via `session_end`, then trigger another `Edit`):

- No new `session_events` row appears.
- No stderr noise in Claude Code (the hook silently no-ops; `result.skipped`
  is internal).
- The host `Edit` completes normally.

## Safety contract

- The hook **never** crashes the host operation. Every failure path
  (missing DB, malformed JSON, no workspace match, no active session,
  better-sqlite3 binding load failure, etc.) writes to stderr at most and
  exits 0.
- Writes go directly via `better-sqlite3` against the choda-deck DB resolved
  via `CHODA_DATA_DIR` / `CHODA_DB_PATH` — the same priority as
  `src/core/paths.ts` `resolveDataPaths()`. No MCP subprocess is spawned per
  hook fire.
- The hook **does not** intercept tool input or modify file contents. It is
  read-only with respect to the edit operation; its only side-effect is the
  INSERT into `session_events`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No rows appear after edits | DB at unexpected path | Set `CHODA_DATA_DIR` in the Claude Code launch env (or `CHODA_DB_PATH` for legacy installs) |
| `[file-edit-event] swallow error: ...` in CC stderr | better-sqlite3 native binding mismatch with node version | `pnpm rebuild better-sqlite3` in the choda-deck repo |
| Rows appear but in the wrong session | Multiple parallel active sessions for the same workspace | Verify via `session_list` + `session_end` the stale one. ADR-009 only guarantees one active session per workspace |

## Related

- ADR-029 — system design (this hook is channel 1).
- ADR-009 — active-session-per-workspace resolution.
- TASK-904 — channel 3 (downstream consumer via `filesChanged` aggregator).
