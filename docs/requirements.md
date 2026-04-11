# Choda Deck — Requirement Analysis

**Status:** in progress — MVP elicitation continuing. Long-term vision captured for later rounds.

**Process:** following `vault/skills/requirement-analysis` — stated → elicited → gap analysis → NFR checklist → acceptance criteria.

---

## Big picture — long-term vision

**Choda Deck is not a terminal multiplexer. It is the physical embodiment of the vault+Choda collaboration system as a desktop workstation.**

Butter has been building a stateful long-term collaboration system between a human architect and an AI assistant (Choda) over the past several months. The vault (Obsidian-backed, PARA-structured) is the shared state brain: it holds memory (who Butter is, preferences, feedback rules, project state), skills (reusable capabilities), task backlogs, ADRs, daily operating rhythm (`/daily`, `/retro`, `/handoff`, `/capture`), and cross-project awareness. Without the vault, Choda is a powerful but stateless chatbot. With the vault, Choda becomes a teammate that walks into every session already knowing the project, the user, the history.

The problem today: that collaboration system is **fragmented across surfaces**. Obsidian for the vault. VS Code / Windows Terminal / Claude Code CLI for code + execution. Multiple windows per project. Alt-tab fatigue. No single surface where the full vault+Choda experience comes together.

**Choda Deck's long-term identity: the unified workstation where Butter and Choda collaborate.**

### Long-term feature scope (V2+ — detailed analysis deferred)

These features embody the full vision. They are **NOT in v0.1 MVP** — they will be analyzed in a separate round of requirement analysis after MVP ships. Listed here so architecture decisions in MVP do not paint the product into a corner.

| Feature area | Long-term behavior |
|---|---|
| **Sidebar structure** | Reflect full vault PARA: `Daily`, `Projects`, `Areas`, `Knowledge`, `Archive` sections. Not just a flat project list |
| **Multiple view types in main pane** | Terminal view (claude session) is one of many. Also: daily note viewer, task list per project, ADR editor, memory inspector, knowledge doc viewer, file tree, cross-project graph |
| **Memory panel** | Inspectable + editable view of the memory files Choda has loaded. Butter can edit/delete memories through UI, no need to open the raw `.md` |
| **Slash commands as UI actions** | `/daily`, `/retro`, `/handoff`, `/capture`, `/weekly-review` accessible via command palette or sidebar buttons. Not typed into claude — invoked natively by Choda Deck UI |
| **Feedback capture button** | When Choda makes a mistake, Butter clicks "save as feedback" → opens a form → writes directly to `memory/feedback_*.md` + updates `MEMORY.md` index |
| **Decision capture button** | Click "save as decision" → draft ADR with fields prefilled from context → Butter reviews → saves to project `docs/decisions/` |
| **Task management** | Sidebar or panel showing tasks per project with status badges, priority, scope. Click to update inline, drag to reorder |
| **Cross-project graph** | Obsidian-style graph view of task/ADR/doc wikilinks across projects |
| **Daily rhythm surface** | Morning: surface today's daily note + active tasks + handoff from yesterday. Evening: prompt for `/handoff` write |
| **Context injection into claude sessions** | When spawning claude in a tab, include the relevant daily note / task / memory snippet as initial context — reducing "what are we working on?" friction |

All of the above stays out of MVP scope. Captured here as the target state to validate that MVP architecture stays composable.

### Architectural implication for MVP

MVP main pane must be a **polymorphic view container**, not hardcoded to "one xterm instance per tab". Concrete: `<ProjectWorkspace>` React component hosts a `<ViewRouter>` that chooses between registered view types. MVP implements one view type (`terminal`). V2+ adds `note`, `tasks`, `adr`, `memory`, `graph` without rewriting the shell.

---

## MVP scope (v0.1)

**Goal:** prove the core collaboration-switching loop with minimum viable features. Ship something real before expanding to the bigger vision.

### In scope for MVP

- Sidebar listing N projects from config (hardcoded JSON at v0.1, config UI deferred)
- Click project → open or switch to that project's tab hosting a live interactive `claude` session in the project's cwd
- Session persistence across tab switches — xterm instance mounted once, reused, not disposed
- Keyboard shortcuts: `Ctrl+1` / `Ctrl+2` / `Ctrl+3` jump to project by index; `Ctrl+Tab` / `Ctrl+Shift+Tab` next/prev
- Graceful shutdown: closing the window kills all live pty processes before Electron quits
- Failure detection + manual restart (per Q1 decision): crashed claude shows banner with "Restart" button, user decides

### Out of MVP (deferred to V2+)

- All features listed in "Long-term feature scope" table above
- Add/remove project via UI (MVP: edit `projects.json` manually)
- Status indicators (busy/idle/waiting for input)
- Cross-tab notifications
- Command palette
- Theming (light/dark/custom)
- Multi-window support
- Cross-platform (MVP is Windows-first; Mac/Linux later)
- Auto-updater
- Plugin / extension API
- Auth, cloud sync, team features

### Actors

| Actor | Profile | Primary need |
|---|---|---|
| Butter (primary) | Solo architect working across automation-rule BE/FE + vault + other repos daily | Zero-friction switching between live Claude sessions per repo without alt-tab fatigue |
| OSS community users (secondary) | Solo devs with similar multi-repo Claude Code workflows | Clone, configure their own `projects.json`, run their workspace |

### Core user flow

1. Launch Choda Deck (morning)
2. See sidebar with N projects from config
3. Click a project → main pane shows a live claude session running in that project's cwd (lazy-spawn on first click)
4. Type into claude, receive output
5. Click a different project → previous session stays alive in background, pane switches to the new one
6. Repeat — session state is preserved across switches
7. Quit app → all claude processes terminate cleanly

---

## Stated requirements

- Desktop application with **Obsidian-style UX**: sidebar project list on the left, content pane on the right with one live interactive Claude Code session per project.
- Each project tab hosts an **interactive** `claude` process (not headless `claude -p`, which loses context between invocations).
- Initial project list: `vault`, `workflow-engine` (automation-rule BE), `remote-workflow` (automation-rule FE). Extensible to more.
- Clicking a project in the sidebar switches the content pane without destroying the underlying claude session — tabs persist across switches.
- Closing the app terminates all live claude processes gracefully.
- Stack: Electron 39 + React 19 + xterm.js 6 + node-pty 1.1 (validated end-to-end in spike — commit `1953bed` + fix `7187791`).
- Long-term build. Open source (MIT). Aiming to contribute back to the community.
- **(Big-picture addition)** Choda Deck will eventually expose the full vault+Choda collaboration system, not just live claude sessions. MVP architecture must stay composable for V2+ extension.

---

## Elicited requirements

### Q1 — Failure mode for crashed claude session

**Decision:** Option (b) — **Notify + prompt**. When a claude session fails (pty onExit with non-zero code, or process crash), Choda Deck shows a banner in that tab's content pane saying "Session crashed, click to restart". User decides whether to restart.

**Implications:**
- Per-tab visual state machine: `idle | running | exited-ok | crashed`
- Detection hook: `pty.onExit` (already wired in spike main process)
- UI element: banner/notification overlay rendered over the xterm instance when state = `crashed`
- Action: "Restart" button re-invokes `pty:spawn` with same project cwd; state → `running`
- **Open sub-question (flagged for later):** "hang detection" (pty alive but no output for a long time) is harder than crash detection — defer to V2 unless Butter requests otherwise

### Q2 — Data lifecycle (what the app stores and persists)

**Decision matrix:**

| Data type | Decision | Notes |
|---|---|---|
| **A. Project config** | **(a3) Hybrid** | `projects.example.json` in-repo (committed, OSS template). `projects.json` in user-data dir (`%APPDATA%/choda-deck/projects.json`) — gitignored, private per user |
| **B. User preferences** (theme, font, keybind overrides, window geometry) | **(b2) None for MVP** | Hardcoded defaults. Deferred to V2 when UX needs personalization |
| **C. Session history / conversation logs** | **(c2) Rely on claude native** | Claude CLI already manages `.claude/conversations/` history. Choda Deck does NOT duplicate. Reduces complexity and storage overhead |
| **D. Workspace state across restart** | **(d2) Partial restore** | Remember project list + last-active project. Do NOT try to resurrect dead pty processes — spawn fresh sessions on next launch. Continuity of "which project was I on" without pretending processes survive quit |
| **E. Runtime logs / crash dumps** | **(e2) Dev-mode console only** | Log to F12 DevTools console during development. No file logging for MVP. Add (e1) rotating file logs later when OSS users report bugs in the wild |

### Q3 — External systems / integration boundaries *(pending)*

### Q4 — (was Butter's big picture — now incorporated in "Big picture" section above)

---

## Pending

- [ ] Q3 — External systems / integration boundaries (claude CLI, filesystem, OS, npm, git, …)
- [ ] Gap analysis (5 techniques: negative scenarios, actor-based, time-based, integration boundary, data lifecycle)
- [ ] NFR checklist (12 categories from `vault/skills/requirement-analysis/references/nfr-checklist.md`)
- [ ] Acceptance criteria (Given-When-Then format)

---

## Assumptions (to revisit)

- Platform: MVP is **Windows-first**. Mac/Linux deferred to V3 roadmap phase.
- Languages: English-only UI. No i18n for v1 (aligned with vault rule: all `.md` in English).
- Accessibility: best-effort keyboard navigation (because Butter uses it), no WCAG compliance target for v1.
- Single-window app: no multi-window split in MVP.
- Single-user: no auth, no cloud sync, no team features.
- One pty per project at a time (not multiple parallel claude sessions within the same project).
- MVP main pane architecture: polymorphic `<ViewRouter>` even though only `terminal` view type is implemented — preserves extensibility for the big-picture vision without blocking MVP shipping.
