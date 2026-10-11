# TASK-2383 — AC verification

`scripts/hooks/attention.mjs` (Claude Code hook for UserPromptSubmit / Stop / Notification) and
`scripts/install-attention-hooks.mjs` (idempotent registration in `~/.claude/settings.json`).
From archived digest idea INBOX-2118.

## Done — 3/4

| # | Criterion | Evidence |
|---|---|---|
| 0 | Stop 150 s after the prompt → notify; 60 s → no; Notification → always | `attention.test.ts` `decide` cases, with the 120 s threshold itself counting |
| 1 | Each event writes/removes `attention/<session_id>.json` with the documented shape; a new prompt removes it | prompt → no file; Stop at +180 s → `{ sessionId, cwd, state: "finished", since }` and one toast "Claude xong việc — choda-deck"; Notification → `waiting`; the next prompt deletes it. A `../evil` session id writes nothing |
| 2 | Running the installer twice leaves exactly one entry per event and keeps every other hook | the real script, run twice on a copy of `~/.claude/settings.json`: 1 attention entry each for UserPromptSubmit / Stop / Notification, `PostToolUse` (file-edit hook) identical, every other setting unchanged. Unit test: uninstall restores the original `hooks` |

The real hook script exits 0 on garbage stdin and with no data dir, so it never breaks a session.

## Needs a human — 1

Seeing a real Windows toast after a turn longer than 2 minutes (TASK-2391). The hooks were installed
in `~/.claude/settings.json` after merge (backup `settings.json.bak-attention`).

## Findings

- Hooks do not inherit `CHODA_DATA_DIR`, so the installer passes `--data-dir` in the hook's args.
- Toast text goes through environment variables, not the PowerShell command line, so the text needs
  no quoting.
- Full suite: 185 files passed; `ac-review` and `http-transport` dropped out with the documented
  "Worker forks emitted error" flake, and pass 35/35 when run alone.
