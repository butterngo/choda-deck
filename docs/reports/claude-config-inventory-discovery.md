---
requirement: "i'm having a problem with inventory, i don't know many skill, mcp global and local(pre-project) sometime i want to review and editable but impossiable, help me think BE and design how can do it, i expect it must be related to projects i don't want to introduce more menu, first of all create an mockup to review before implementation"
started: 2026-09-03
workspace: Main (choda-deck) — contract read here; the view ships in Companion
status: converged
thread: CONV-1788409240451-66
---

# Discovery — an inventory of skills and MCP servers, reviewable and editable, inside the existing project navigation

## Round 1 — read the contract and find where the config actually lives

### New evidence this round

| Source | What it settled | Citation |
|---|---|---|
| conversation | round 0 only — no human message yet | [conversation CONV-1788409240451-66] |
| code | The companion adapter is **GET-only by default**. Writes exist on exactly three surfaces: `POST /capture`, the workflow routes, and `POST /sync/pull\|push`. Everything else hits a 405. | `choda-deck/src/adapters/companion/http-server.ts:60-172` |
| code | `workspace-docs` already serves a workspace's **whole tree**, read-only, token-gated, sandboxed to the workspace cwd — the read half of this feature already exists for anything inside a repo | `choda-deck/src/adapters/companion/workspace-docs.ts:1-25` |
| code | `vault.ts` is sandboxed to `<vaultDir>/30-Knowledge` so a sibling directory is *structurally* unreachable, not merely unlisted — the precedent for serving a path outside any workspace | `choda-deck/src/adapters/companion/http-server.ts:150-158` |
| disk | **All 6 MCP servers are global**, in `~/.claude.json` → `mcpServers`: choda-tasks, playwright, azure-devops, postgres, mcp-atlassian, sqlserver. Every one of the 34 per-project entries has an **empty** `mcpServers` | `C:\Users\hngo1_mantu\.claude.json` |
| disk | Per-project MCP is a **different mechanism**: repos carry `.mcp.json`, and `.claude.json` records only `enabledMcpjsonServers` / `disabledMcpjsonServers` per project. 8 such files exist under `C:\dev` | `C:\dev\mantu\dynamic-ui\.mcp.json`, `.claude.json` project keys |
| disk | 15 global skills in `~/.claude/skills/`; exactly **one** project skill in the whole tree (`choda-deck/.claude/skills/mermaid`). Frontmatter is `name` + `description` (+ optional `allowed-tools`) | `~/.claude/skills/`, `C:\dev\choda-deck\.claude\skills\mermaid\SKILL.md:1-4` |
| disk | `.claude.json` is **124 KB and mostly not MCP** — `userID`, startup counters, onboarding flags, per-project `allowedTools` and trust-dialog state all live in the same file | `C:\Users\hngo1_mantu\.claude.json` |
| disk | Two project keys differ **only by drive-letter case**: `C:/dev/choda-deck` and `c:/dev/choda-deck`, each with its own settings | `.claude.json` → `projects` |
| code | The web shell already carries **8 top-level nav items**; the workspace view has 3 tabs (files / tasks / history) | `companion/packages/web/src/components/nav/*`, `views/WorkspaceView.tsx:33` |
| ADR | The companion adapter must never touch MCP code — isolation is the contract | knowledge `companion-adapter-must-add-zero-mcp-edits` |
| ADR | A companion write-action must confirm first and surface result **or** error — never silent | knowledge `companion-write-actions-must-confirm-surface-result-or-error-never-silent` |

### Scores

| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 7 | Stated first-hand, and now sized: 15 skills + 6 global servers + 8 project `.mcp.json` are invisible in the companion | what "review" means in practice — read? compare scopes? enable/disable? |
| 2 | Scope & boundary | 4 | Two constraints are firm (hangs off projects, no new menu). "Editable" is undefined, and the global/project split makes it worse: **MCP is global, skills are effectively global too** — so a project-scoped view is showing mostly non-project data | a human call (§5) — see the three questions below |
| 3 | Technical contract | 7 | GET-only guard, the three write surfaces, and the workspace-docs sandbox are all read | no route reaches `~/.claude` (outside every workspace cwd); no file-write path exists at all |
| 4 | Prior art | 7 | Two governing gotchas found and read | ADR-036's LOCAL-ONLY capture guard not yet read — it is the closest precedent for a gated write |
| 5 | Edges & failure | 4 | One real edge already found without looking: duplicate drive-letter-case project keys, and a 124 KB `.claude.json` where MCP is a minority of the file | trace what else keys on `.claude.json`; decide the disabled/enabled-vs-defined distinction |
| 6 | NFR | 2 | untouched | walk the 12-category checklist |
| 7 | Acceptance criteria | 2 | none exist | blocked on #2 and #3 |

**TOTAL = MIN = 2** (dimensions 6 and 7)
Round 0: MIN 1 → round 1: MIN 2. New evidence? **YES** (12 citations) → may continue.

### Score history

| # | Dimension | R0 | R1 |
|---|---|---|---|
| 1 | Problem & value | 5 | 7 |
| 2 | Scope & boundary | 3 | 4 |
| 3 | Technical contract | 2 | 7 |
| 4 | Prior art | 2 | 7 |
| 5 | Edges & failure | 2 | 4 |
| 6 | NFR | 2 | 2 |
| 7 | Acceptance criteria | 1 | 2 |
| | **MIN** | **1** | **2** |

### The finding that reframes the requirement

The requirement says "global and local (per-project)". On this machine that split
is **not symmetric, and barely exists**:

- **MCP servers** — 6 defined globally, 0 defined per project. What a project
  actually owns is a `.mcp.json` in the repo plus an enable/disable list in
  `.claude.json`. So a project's MCP story is "which of the global six am I
  running, plus whatever this repo declares" — a *projection*, not a set.
- **Skills** — 15 global, 1 project-local in the entire `C:\dev` tree.

A view that renders "this project's skills and servers" would therefore be empty
or near-empty for almost every project, which is the opposite of the problem
being solved. The useful view is the **effective inventory seen from a project**:
everything reachable here, each row labelled with where it came from and whether
it is on.

That is also what makes the no-new-menu constraint work rather than merely obey
it — a 4th tab in `WorkspaceView` beside files / tasks / history.

### Round 2 will look for exactly this
- The three blocking scope questions (#2) — human decision, asked now, not searched
- Read ADR-036's LOCAL-ONLY guard (#4) and decide whether a write is even permissible (#3)
- Walk the NFR checklist (#6)
- Only then write acceptance criteria (#7)

## Round 2 — the decision landed, and the disk contradicted the plan

### New evidence this round

| Source | What it settled | Citation |
|---|---|---|
| Butter (chat) | **"Editable" = read + open in the real editor. The companion writes nothing.** Explicitly out: editing in the app, on/off toggles, any write to `.claude.json` | [Butter, 2026-09-03] |
| code | There is **no preload, no `contextBridge`, no `ipcMain`** anywhere in `electron/`. The window is `contextIsolation: true`, `nodeIntegration: false`, and loads `http://127.0.0.1:<port>/` — the renderer is an ordinary web page with no bridge to the main process | `companion/electron/main.cjs:174-192` |
| code | The bridge token "stays in the main process; never reaches the renderer" — the static proxy injects it on the way through | `companion/electron/main.cjs:166-170` |
| code | `vault.ts` picks its sandbox root as the **subdirectory** (`30-Knowledge`), not the vault, precisely so `20-Areas` is unreachable *structurally* rather than by a filter | `choda-deck/src/adapters/companion/vault.ts:9-13` |
| disk | **29 `SKILL.md` files live under `~/.claude/plugins/`, but exactly ONE plugin is installed** (`frontend-design@claude-plugins-official`). The other 28 sit in `marketplaces/` — a catalogue of what *could* be installed | `~/.claude/plugins/installed_plugins.json` |
| disk | `~/.claude/skills/` has **15 directories but only 13 `SKILL.md`** — `README.md` and `docs/` are not skills | `~/.claude/skills/` |
| measurement | Parsing the 124 KB `.claude.json`: **10 ms**. Reading all 13 skill frontmatters: **5 ms** | measured 2026-09-03 |
| disk | `~/.claude/` also holds `history.jsonl`, `sessions/`, `projects/` (full transcripts), `shell-snapshots/` | `~/.claude/` |

### The finding that would have shipped a wrong number

A naive implementation — "walk the tree, collect every `SKILL.md`" — reports **42 skills**.
The true effective set is **15**: 13 global + 1 from the one installed plugin + 1 project skill.

The 27 extras are marketplace listings for plugins that were never installed. Shipping that
count would not merely be inaccurate; it would *deepen* the exact confusion this feature
exists to remove. `installed_plugins.json` is the discriminator, and nothing about the
directory layout hints that it is needed.

### The constraint prior art hands us, unchanged

`vault.ts` chose `30-Knowledge` as its sandbox root rather than the vault, so that
`20-Areas` could not be reached even by a bug. The same reasoning applies here and is
stronger: `~/.claude/` holds `history.jsonl`, `sessions/` and `projects/` — every prompt
ever typed. **The sandbox root must be `~/.claude/skills`, never `~/.claude`.** MCP config
is a separate, field-projected read of `.claude.json` — never a file route.

### The cost that changed, and the new decision it forces

"Open in editor" sounded free. It is not, and the reason is structural rather than
budgetary:

| Route | What it costs | Where it fails |
|---|---|---|
| Electron IPC (`shell.openPath`) | a preload script + a `contextBridge` channel — the app's **first**; the renderer currently has no bridge at all | does nothing when the UI is opened in a normal browser against the same local port |
| An adapter route that spawns an editor | the adapter launching a process — a far larger security step than the file write we just ruled out | contradicts the read-only decision it was meant to satisfy |
| Show the absolute path + copy button | nothing new; the path is already in the payload | one manual paste |

The third was not on the menu when the decision was made, and it may be what "review" needed
all along.

### Scores

| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | 42 files on disk vs 15 real; the confusion is structural, not inattention | — |
| 2 | Scope & boundary | 8 | read-only settled by Butter; in/out both named | whether `commands/` (1 entry) is in scope |
| 3 | Technical contract | 8 | route shape fully specified by the `vault.ts` precedent; sandbox root decided | the open-in-editor mechanism has no existing surface |
| 4 | Prior art | 9 | three governing entries read; the sandbox-root rule applies directly | — |
| 5 | Edges & failure | 8 | installed-vs-marketplace, dir-without-SKILL.md, duplicate drive-letter keys, malformed `.mcp.json`, missing `~/.claude`, traversal | symlinks unexamined |
| 6 | NFR | 9 | 12/12 — performance measured, security is the sandbox root + token gate, 8 defaulted | — |
| 7 | Acceptance criteria | 7 | drafted below and falsifiable, but one criterion depends on the editor decision | that decision |

**TOTAL = MIN = 7** (dimension 7)
Round 1: MIN 2 → round 2: MIN 7. New evidence? **YES** (8 sources) → may continue.

### Score history

| # | Dimension | R0 | R1 | R2 |
|---|---|---|---|---|
| 1 | Problem & value | 5 | 7 | 9 |
| 2 | Scope & boundary | 3 | 4 | 8 |
| 3 | Technical contract | 2 | 7 | 8 |
| 4 | Prior art | 2 | 7 | 9 |
| 5 | Edges & failure | 2 | 4 | 8 |
| 6 | NFR | 2 | 2 | 9 |
| 7 | Acceptance criteria | 1 | 2 | 7 |
| | **MIN** | **1** | **2** | **7** |

### Draft acceptance criteria

- [ ] AC-1 — Given a workspace, when the Setup tab is opened, then it lists exactly the skills that are actually in effect (13 global + 1 installed-plugin + any project skill), and a marketplace plugin that is not installed appears nowhere. Fail: the count is 42, or a `cwc-makers` skill is listed.
- [ ] AC-2 — Every row names its origin (Global / This project / Plugin) and no row is unlabelled. Fail: a row's scope has to be inferred from its name.
- [ ] AC-3 — A directory under `~/.claude/skills` with no `SKILL.md` is not listed as a skill. Fail: `README.md` or `docs` appears as a row.
- [ ] AC-4 — MCP servers are read as fields of `.claude.json`, never as a file the route can serve; a request for a path outside `~/.claude/skills` returns 403 and no bytes. Fail: `history.jsonl` or anything under `sessions/` is retrievable.
- [ ] AC-5 — A repo `.mcp.json` that is malformed shows the server row as unreadable with the parse error named; it does not blank the pane or crash the tab. Fail: the whole Setup tab errors.
- [ ] AC-6 — The tab strip goes from three entries to four and the sidebar is unchanged at eight. Fail: a new top-level nav item exists.
- [ ] AC-7 *(blocked)* — the open-in-editor / show-path criterion, once that decision is made.

### Round 3 will look for exactly this
- The open-in-editor decision (#3, #7) — human call, the last blocker
- Whether `commands/` is in scope (#2)
- Symlink behaviour under the sandbox root (#5)

## Round 3 — "everything" broke the sandbox rule, and a live symlink decided the fix

### New evidence this round

| Source | What it settled | Citation |
|---|---|---|
| Butter (chat) | Opening a file = **show the absolute path + copy button**. No preload, no IPC, no process launch. And scope = **all four groups**: skills, MCP servers, slash commands, rules & settings | [Butter, 2026-09-03] |
| disk | **`~/.claude/commands` is a symlink** to `C:\Users\hngo1_mantu\vault\.claude\commands`. It is the only symlink under any candidate root, and it exists today | `~/.claude/commands` |
| disk | `~/.claude/CLAUDE.md` is a single file (4,844 bytes), not a directory | `~/.claude/CLAUDE.md` |
| disk | The project half — `.claude/rules/typescript.md`, `.claude/skills/`, `.claude/settings.local.json`, `.mcp.json`, `CLAUDE.md` — all live **inside the workspace cwd** | `C:\dev\choda-deck\.claude\rules\typescript.md` |
| disk | The deny side of `~/.claude` is concrete: `history.jsonl`, `sessions/`, `projects/`, `shell-snapshots/`, `session-env/` | `~/.claude/` |

### The contradiction "everything" introduced

Round 2 concluded: sandbox root = `~/.claude/skills`, never `~/.claude`, because the parent
holds every transcript ever recorded.

Widening scope to commands and CLAUDE.md breaks that root — those are siblings of `skills`,
not children. Taking the parent as the root would re-expose exactly what round 2 excluded.

**Resolution: an allowlist of roots, not one root.** Four entries, resolved once at startup:

- `~/.claude/skills`
- `~/.claude/commands`
- `~/.claude/CLAUDE.md` (a single file, allowed by exact path)
- the `installPath` of each entry in `installed_plugins.json`, plus `/skills`

Everything else under `~/.claude` is unreachable because it was never named — the same
structural stance `vault.ts` took, expressed as a set instead of a prefix.

### The symlink is not hypothetical, and it decides the check

`~/.claude/commands` already points into the vault. That makes the two naive
implementations wrong in opposite directions:

- **Resolve symlinks, then prefix-check against `~/.claude/commands`** — the real path is
  under `vault\`, the check fails, and slash commands are invisible. The feature quietly
  loses a whole group.
- **Do not resolve** — any symlink placed under an allowed root escapes the sandbox, and
  this one *already* reaches into the vault, whose `20-Areas` (preferences, goals) was
  deliberately made unreachable in TASK-1576.

**The check must realpath both sides**: resolve each allowlist root once at startup, and
compare the resolved requested path against that resolved set. `~/.claude/commands` then
resolves to `vault\.claude\commands`, which becomes an allowed root in its own right —
`vault\20-Areas` is still not in the set, so it stays unreachable.

### The simplification nobody asked for

The project half needs **no new route at all**. `.claude/rules`, `.claude/skills`,
`.claude/settings.local.json`, `.mcp.json` and a project `CLAUDE.md` are all inside the
workspace cwd, which `workspace-docs` already serves as a whole tree, read-only and
token-gated. Only the *global* half needs the new allowlisted route.

### Scores

| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | 42 files on disk vs 15 real; four groups invisible from anywhere | — |
| 2 | Scope & boundary | 9 | four groups in; writes, toggles and in-app editing explicitly out; opening = path + copy | — |
| 3 | Technical contract | 9 | project half reuses `workspace-docs`; global half is one route over a resolved-root allowlist; MCP is a field projection of `.claude.json` | — |
| 4 | Prior art | 9 | `vault.ts` sandbox stance, zero-MCP-edits, write-actions-confirm — all read and applied | — |
| 5 | Edges & failure | 9 | symlink (live instance), installed-vs-marketplace, dir without `SKILL.md`, malformed `.mcp.json`, missing `~/.claude`, duplicate drive-letter keys, traversal | — |
| 6 | NFR | 9 | 12/12; performance measured at 10 ms + 5 ms; security is the allowlist + realpath + token gate | — |
| 7 | Acceptance criteria | 9 | 9 criteria, each names a surface and a failure that differs from its pass | — |

**TOTAL = MIN = 9** — converged.
Round 2: MIN 7 → round 3: MIN 9. New evidence? **YES** (5 sources).

### Score history

| # | Dimension | R0 | R1 | R2 | R3 |
|---|---|---|---|---|---|
| 1 | Problem & value | 5 | 7 | 9 | 9 |
| 2 | Scope & boundary | 3 | 4 | 8 | 9 |
| 3 | Technical contract | 2 | 7 | 8 | 9 |
| 4 | Prior art | 2 | 7 | 9 | 9 |
| 5 | Edges & failure | 2 | 4 | 8 | 9 |
| 6 | NFR | 2 | 2 | 9 | 9 |
| 7 | Acceptance criteria | 1 | 2 | 7 | 9 |
| | **MIN** | **1** | **2** | **7** | **9** |

## All dimensions >= 9 after 3 rounds

| # | Dimension | Score | WHY it earned 9 — evidence, not confidence |
|---|---|---|---|
| 1 | Problem & value | 9 | A naive walk reports 42 skills against a real 15 (`installed_plugins.json`); four config groups are unreachable from the companion today |
| 2 | Scope & boundary | 9 | Butter settled read-only + path-and-copy + all four groups; in and out are both written down |
| 3 | Technical contract | 9 | Project half = existing `workspace-docs` (whole tree, read-only, token-gated). Global half = one GET route over four realpath-resolved roots. MCP = field projection of `.claude.json`, never a file route |
| 4 | Prior art | 9 | `vault.ts:9-13` (sandbox root as the narrow directory), `companion-adapter-must-add-zero-mcp-edits`, `companion-write-actions-must-confirm…` — the last is moot since nothing writes |
| 5 | Edges & failure | 9 | Every edge has a named behaviour, and the sharpest one is a live instance rather than a guess: `~/.claude/commands` is a symlink into the vault |
| 6 | NFR | 9 | 12/12 answered; performance measured (10 ms parse, 5 ms headers); 8 defaulted per the checklist |
| 7 | Acceptance criteria | 9 | 9 criteria; each names a surface, has one verdict, and states a failure that differs from its pass |

**Exemptions:** none.

**Unproven assumptions carried forward:**

1. The plugin-skill layout (`<installPath>/skills/*/SKILL.md`) was observed on **one**
   installed plugin. A plugin that nests skills differently would be missed.
2. `enabledMcpjsonServers` / `disabledMcpjsonServers` semantics are inferred from the field
   names, not from reading Claude Code's own source. The On/Off badge rests on that reading.
3. Only this machine was examined. Another machine could genuinely populate per-project
   `mcpServers`, which would make the "it is barely a split" reframe less true there.
4. Symlinks were checked to depth 4 under the candidate roots. A deeper one would not have
   been seen — the realpath check handles it regardless, which is why the assumption is
   tolerable.

**Rounds:** 3 · **evidence:** 25 citations across code (9), disk (11), ADR/knowledge (3), measurement (2)

### Acceptance criteria — final

- [ ] AC-1 — Given a workspace, when Setup is opened, then the skills listed are exactly the effective ones (13 global + 1 installed-plugin + any project skill); a marketplace plugin that is not installed appears nowhere. Fail: the count is 42, or a `cwc-makers` skill is listed.
- [ ] AC-2 — Every row names its origin (Global / This project / Plugin) with no row unlabelled. Fail: scope has to be inferred from the name.
- [ ] AC-3 — A directory under `~/.claude/skills` with no `SKILL.md` is not a row. Fail: `README.md` or `docs` appears as a skill.
- [ ] AC-4 — Slash commands are listed even though `~/.claude/commands` is a symlink into the vault. Fail: the group is empty on this machine.
- [ ] AC-5 — A request resolving outside the four allowlisted roots returns 403 with no bytes, including via a symlink planted under an allowed root. Fail: anything under `sessions/`, `projects/`, `history.jsonl` or `vault/20-Areas` is retrievable.
- [ ] AC-6 — MCP servers are read as fields of `.claude.json`; no route serves that file. Fail: the file is fetchable.
- [ ] AC-7 — A malformed repo `.mcp.json` renders that row as unreadable with the parse error named; the rest of the tab still renders. Fail: the tab blanks or throws.
- [ ] AC-8 — Selecting any row shows its absolute path with a copy control, and the companion writes nothing to disk in the whole flow. Fail: a write occurs, or the path is not copyable.
- [ ] AC-9 — The workspace tab strip goes from three to four; the sidebar stays at eight. Fail: a new top-level nav item exists.
