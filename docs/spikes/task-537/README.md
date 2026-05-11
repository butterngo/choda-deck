# TASK-537 spike — `claude -p` spawn contract validation

Frozen archive of the spike that validated the HarnessRunner spawn contract for headless `claude -p`. Captured 2026-04-19; informed ADR-014 v3.4 (and downstream ADR-017 headless spawn strategy).

Source: branch `spike/task-537-headless-claude`, single commit `5e11c1a`. Branch is now deleted — the script lives here so the evidence survives.

## Layout

- `scripts/spike-harness-headless.mjs` — 10 assumption tests against real `claude -p`. Not wired into `package.json`. Estimated total cost when re-run: < $0.50.

## Findings (documented in ADR-014 v3.4)

- Tool restriction flag is `--tools`, not `--allowed-tools`.
- `CLAUDE.md` resolution walks up the parent directory tree from `cwd`.
- Settings can leak across runs via `cwd` — pin explicitly.
- Soft budget cap behavior — observed (not enforced).
- Other contract details captured in the spike output and ADR.

## Why this is archived, not re-runnable

Like TASK-610, the script targets a specific `claude` CLI version and environment (April 2026). Treat as historical evidence behind ADR-014 / ADR-017, not a regression suite.
