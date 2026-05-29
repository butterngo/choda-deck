---
type: decision
title: "ADR-023: auto-safe v2 hardening — 3 trust fixes từ TASK-726 retro"
projectId: choda-deck
scope: project
refs:
  - path: src/core/executor/coder.ts
    commitSha: 6ed604e21cf15bfa75daf282b42f8387db73f812
  - path: .github/workflows/ci.yml
    commitSha: 6ed604e21cf15bfa75daf282b42f8387db73f812
  - path: .claude/rules/typescript.md
    commitSha: 6ed604e21cf15bfa75daf282b42f8387db73f812
createdAt: 2026-05-13
lastVerifiedAt: 2026-05-29
status: superseded
---

> **Status (2026-05-29): SUPERSEDED by TASK-982 — queue runner subsystem removed.**
> The `auto-safe` validator that this ADR hardened was deleted along with the rest of the
> queue runner. The 3 trust fixes documented here no longer apply because the contract they
> protected is gone. Backup branch: `origin/archive/queue-runner` at `45ef97c`. See ADR-019
> supersession note for the wider rationale.

# ADR-023: auto-safe v2 hardening — 3 trust fixes từ TASK-726 retro

> **Status:** Proposed — 2026-05-13
> **Trigger:** TASK-726 PR #95 ship cùng task nhưng nổ 4 auto-safe issue. Butter note ở INBOX-225: *"worth gathering into a single ADR auto-safe v2 hardening instead of 5 disjoint tasks if Butter wants to design holistically"*.

---

## Context

[[auto-safe-label-spec]] định nghĩa task body contract. Validator giữ contract đúng — TASK-726 không vi phạm contract. [[ADR-019-autonomous-queue-runner]] orchestrate sequential spawn. ADR-019 cũng không sai.

Vấn đề nằm ở **3 layer ngoài validator + orchestrator** — chỗ trust erode giữa "task body đạt contract" và "PR thật sự sạch":

1. **Runtime prompt** (`src/core/executor/coder.ts`) — Claude verify AC giữa chừng rồi declare done, không re-run ở final state. Runner's post-spawn AC check catches it (đúng vai trò), nhưng waste $1+ spawn lẽ ra pass được.
2. **CI smoke** — commit `56948f6` xóa `scripts/smoke-cli.mjs`. PR #95 xóa nốt dangling workflow step. Hệ quả: ship `dist/cli.cjs` + `dist/mcp-server.cjs` chỉ có unit test, không validate bundle dispatch.
3. **Code rule** — Claude default `content.split('\n')` không CRLF-safe. Windows ship-target + `core.autocrlf` machine-config-dependent = blind spot recurring. TASK-726 PR #95 fix bằng commit `50ac5ae` (`/\r?\n/`) ở 2 parser, nhưng grep `src/**/*.ts` còn 10 file dùng `split('\n')` — chưa audit.

Pattern: validator + orchestrator giữ chuẩn input/output; **3 layer này là chỗ trust giữa Claude tự-declare-done và reality**. Vá lẻ 5 task con không thấy được dây nối. Gom 1 ADR + 3 sub-task để rationale có 1 chỗ duy nhất.

## Decision

Ship **3 fix độc lập, không amend [[auto-safe-label-spec]]** (contract giữ nguyên — đây là defense-in-depth ngoài contract):

### Fix 1 — Coder prompt: re-run AC tại FINAL state

- **Site**: `src/core/executor/queue-claude-spawn.ts` — exported const `QUEUE_AC_FINAL_VERIFY_NUDGE`, appended to stdin assembly (after `${prefix}\n\n${taskBody}`).
- Append role prompt: *"After all file edits, re-run every command in ## Acceptance ONCE MORE before declaring done. If any AC command exits non-zero, fix and re-run, until all pass at the FINAL filesystem state."*
- L1 only — không thay đổi parser. L2 (synthetic Final Verification block trong AC parser) defer cho đến khi đo được L1 không đủ.
- Verify: spawn debug `claude -p` với new prompt, assert log có 2 lần AC command invocation (mid + final).

> **Site correction (TASK-732, 2026-05-14)**: original draft listed `coder.ts` ClaudePCoderDriver as the site, asserting "coder.ts prompt share giữa queue + pilot". Verification: `ClaudePCoderDriver` is the FE Playwright spec-writer (its `CODER_SYSTEM_PROMPT` explicitly says "Do not run tests") and is *not* the spawn path TASK-726 cost waste came from. The queue runner spawns via `createQueueClaudeSpawner` in `queue-claude-spawn.ts` — separate, sends `${prefix}\n\n${taskBody}` via stdin, no `--append-system-prompt`. Fix moved there. FE pilot deliberately not patched — it doesn't run AC.

### Fix 2 — Rebuild post-build smoke harness

- Site: new `scripts/smoke-cli.mjs` + `.github/workflows/ci.yml` Smoke CLI step
- Coverage tối thiểu (current CLI surface post-`56948f6`):
  - `node dist/cli.cjs --help` exit 0, output chứa `mcp serve`/`run-queue`/`queue start`/`queue report`
  - `node dist/cli.cjs run-queue --help` exit 0, chứa required flags
  - `node dist/cli.cjs run-queue --workspace nonexistent --dry-run` exit 3
  - `node dist/cli.cjs queue report nonexistent` exit 1
  - (Optional) MCP bundle smoke: spawn `node dist/mcp-server.cjs`, gửi JSON-RPC `initialize`, expect result, kill
- Workflow matrix: `windows-latest` + `ubuntu-latest`
- Isolate state qua `CHODA_DATA_DIR=<runner-tmp>` (per existing CI pattern)

### Fix 3 — Line-parsing rule + util

- New `src/core/utils/lines.ts` exports `splitLines(content: string): string[]` → `content.split(/\r?\n/)`
- `.claude/rules/typescript.md` thêm subsection "Line-based parsing":
  > Khi parse file contents thành lines, dùng `splitLines()` từ `src/core/utils/lines.ts` (split `/\r?\n/`), KHÔNG `content.split('\n')`. Choda-deck ship Windows-first; artifact files thường CRLF. Reference: TASK-726 commit `50ac5ae`.
- Migrate existing call sites: `src/core/executor/queue-report.ts` (đã fix CRLF tay nhưng dùng raw regex) + 9 file khác từ audit grep
- Audit + migrate phải kèm test cho `splitLines` (`'a\nb\r\nc'` → `['a','b','c']`)

## Out of scope

- **Không amend `auto-safe-label-spec`** — validator contract giữ nguyên. Fix 1/2/3 là chuỗi defense-in-depth ngoài contract, không cần new label rule.
- **Không retroactive** — completed queue runs không re-spawn dù prompt cũ.
- **Không port sang FE Playwright pilot** — FE pilot (`coder.ts:ClaudePCoderDriver`) is a spec-writer that explicitly does not execute AC, so the nudge is a no-op there. Smoke harness scope FE pilot also defer.
- **L2 Final Verification AC-parser injection** — chỉ ship nếu sau 5 queue runs L1 vẫn fail.

## Rollout

3 PR độc lập. Order recommend (cheapest → heaviest):

1. **Fix 3** (rule + util) — pure code, không cross system. Ship trước để pattern lan vào codebase ngay.
2. **Fix 1** (prompt) — single file, observable qua next queue run.
3. **Fix 2** (CI infra) — heaviest, cần test matrix Windows + Ubuntu. Ship cuối khi đã có signal Fix 1 + 3 work.

## Revisit when

- 5 queue runs sau Fix 1 ship, vẫn ≥1 case Claude declare done sai → ship L2 (synthetic Final Verification AC injection)
- Audit grep Fix 3 phát hiện thêm Windows-fragile pattern khác (`os.EOL`, `path.sep` assumption, etc.) → mở rộng rule
- Auto-safe runner rename / replace → re-evaluate Fix 1 prompt placement

## Related

- TASK-726 PR #95 (origin của 3 issue)
- Commit `56948f6` (origin Fix 2 gap)
- Commit `50ac5ae` (manual fix CRLF tại 2 site, gốc Fix 3)
- INBOX-220 → task Fix 1
- INBOX-222 → task Fix 2
- INBOX-225 → task Fix 3
- [[auto-safe-label-spec]] — validator contract (không đổi)
- [[ADR-019-autonomous-queue-runner]] — runner orchestration (không đổi)
- [[ADR-017-headless-spawn-strategy]] — `claude -p` spawn (prompt site cho Fix 1)
- Memory `feedback_ac_post_build_smoke` — gốc của Fix 2 rationale
- Memory `feedback_grep_before_pinning_file_paths` — sibling pattern, "verify trước khi assume" (Fix 3 cùng họ)
