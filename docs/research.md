# Choda Deck — Research Backlog

**Purpose:** living document of open research questions for Choda Deck MVP and V2+ planning. Each item captures a question we don't have enough information to decide on yet. Status is updated as investigation progresses; findings are filled in when items close.

**Process:** a research item starts as `open`. When investigation begins, status → `in-progress`. When a clear answer exists, status → `done` and the Findings subsection is filled. No item is closed without a concrete recommendation.

**How to work on this file:**
- Pick an `open` item, change status to `in-progress`, commit.
- Investigate (web search, docs, spike code, existing code reading). Keep notes in the item's Findings subsection.
- When enough is known to make a decision, change status to `done` and write the final recommendation.
- If research is inconclusive, stay `in-progress` and note what's still unclear.

---

## Backlog summary

### MVP-relevant (research before or during MVP build)

| ID | Question | Blocks | Status |
|---|---|---|---|
| R1 | Does xterm.js render full claude TUI behavior correctly? (alt screen, mouse, bracketed paste, unicode, Cascadia font edge cases) | MVP feature quality | open |
| R3 | Graceful pty shutdown flow on Windows — does `ptyProcess.kill()` send proper termination, and do we need to replicate claude's "Ctrl+C twice to exit" dance before force-kill? | MVP graceful shutdown | open |
| R4 | Window resize propagation — does FitAddon + pty resize make claude re-layout its TUI correctly when cols/rows change? | MVP UX | open |
| R6 | React state management choice for Choda Deck (useState + prop drilling / useContext + useReducer / Zustand / Redux Toolkit / Jotai)? | MVP architecture + V2 extensibility | open |
| R11 | PATH handling when spawning claude for OSS users — how to make `claude.cmd` findable when user installed via npm global, Homebrew, yarn global, scoop, or standalone? | MVP cross-environment reliability | open |

### V2+ planning (capture now, investigate later)

| ID | Question | Blocks | Status |
|---|---|---|---|
| R9 | Vault integration pattern — read-only, watch-mode, or write-back? Markdown parser (`remark` + `remark-wiki-link` vs custom)? How to read Obsidian vault structure programmatically? | V2 PARA sidebar, memory panel, task list, ADR editor | open |
| R10 | Claude Code auth state detection — does claude CLI expose session health or token-expiry signals Choda Deck can detect? | V2 reliability (re-auth banner instead of silent fail) | open |
| R14 | Context injection into a running claude session — how to programmatically inject vault context (daily note, task snippet, memory) into claude's stdin while session is live? Pipe text? Simulate keystrokes? Does claude CLI have an external-context-feed API? | V2 core feature (big-picture vision #10) | open |

---

## Items — detailed

### R1 — xterm.js rendering fidelity for claude TUI

**Question.** Does xterm.js 6 faithfully render everything claude Code's TUI does on Windows via ConPTY, or are there edge cases that break the experience?

**Why it matters.** The spike only ran `claude.cmd` for ~4 seconds and captured 4265 bytes of output. It confirmed banner rendering, colors, box drawing, and Ctrl+C input. But claude's interactive UI has many features not exercised in that short test:

- **Alt screen mode** — slash command picker (`/model`, `/compact`, `/help`...) typically renders as a popup that enters alt screen. If xterm.js doesn't handle alt screen + return correctly, slash commands will corrupt the terminal buffer.
- **Mouse events** — click to position cursor, mouse scroll, click-drag selection. xterm.js has MouseTracking modes but needs to forward events through the pty correctly.
- **Bracketed paste** — pasting multi-line text (like Butter's long instructions or code blocks) should arrive as a single event, not N keypresses. xterm.js supports bracketed paste but claude needs to request it.
- **Unicode rendering** — Butter types Vietnamese frequently (session history confirms). Font fallback for missing glyphs. Emoji rendering. CJK width handling.
- **Font metrics with Cascadia Code** — the default font we're proposing. Ligature support, line-height consistency, cursor alignment.
- **Scrollback buffer** — long claude output (large diffs, file dumps). Memory and performance as scrollback grows.

**What to investigate:**
1. Web search "xterm.js alt screen support" + "xterm.js claude code rendering issues"
2. Read xterm.js docs on supported terminal features (modes, mouse, bracketed paste)
3. Check claude CLI source or docs (if available) for which TUI features it uses
4. Write a targeted spike script that sends each feature through the pipeline and captures rendered bytes
5. Known issues in xterm.js GitHub issues tagged `windows`, `conpty`, `tui`

**Acceptance for closing this item.** A decision on: (a) xterm.js handles everything claude needs on Windows — proceed with MVP as-is, or (b) identified specific broken features — list workarounds or alternative libraries, or (c) need further spike before deciding.

**Findings.** _(pending)_

---

### R3 — Graceful pty shutdown on Windows

**Question.** When Choda Deck quits, how do we cleanly terminate N live `claude` pty processes without orphans, stale session locks, or data loss?

**Why it matters.** Claude has explicit exit protection: hitting `Ctrl+C` once shows "Press Ctrl-C again to exit" (observed in Stage 1 spike output). This suggests a confirmation dialog or interrupt handler that won't honor a single Ctrl+C. If we force-kill the pty process directly with `ptyProcess.kill()`, we skip whatever claude wants to clean up:

- In-flight conversation auto-save
- Session lock files in `.claude/`
- Graceful disconnection from Anthropic API
- Any shell history flush

`node-pty` exposes `kill(signal?)`. On Windows, ConPTY translates signals differently than POSIX. We need to know what SIGTERM / SIGINT / SIGHUP actually do in this context.

**What to investigate:**
1. node-pty documentation and source for Windows kill semantics
2. Claude CLI docs for shutdown behavior (if any exit flags, clean-exit endpoints)
3. Experiment: spike a script that spawns claude, sends `\x03` (Ctrl+C) twice with 100ms delay, observes exit cleanliness vs direct kill
4. Check for leftover lock files / orphan processes after each approach
5. Electron `before-quit` event and how to do async cleanup before quit completes (app.quit vs preventDefault pattern)

**Acceptance.** Concrete shutdown sequence documented: "when Choda Deck quits, for each session, send X, wait Y ms, if still alive send Z, wait W ms, finally force kill". Plus which Electron lifecycle hook to wire it into (`before-quit` with `preventDefault + async cleanup + app.quit()`).

**Findings.** _(pending)_

---

### R4 — Resize propagation FitAddon → pty → claude

**Question.** When the Choda Deck window resizes (or the sidebar collapses/expands), does the chain `ResizeObserver → FitAddon.fit() → pty.resize(cols, rows) → claude SIGWINCH` work correctly on Windows ConPTY, causing claude to re-layout its TUI?

**Why it matters.** The spike's renderer has a `ResizeObserver` that calls `fitAddon.fit()` and then `window.api.pty.resize(id, cols, rows)`. But it wasn't stress-tested. Known risks:

- ConPTY resize on Windows is a newer API and historically had bugs with rapid resize events
- Claude may not redraw its full UI on SIGWINCH — some TUIs only redraw the prompt line
- FitAddon calculations depend on DOM layout timing — reading cell width before font loads gives wrong measurements
- Resizing while claude is mid-render can corrupt the buffer

**What to investigate:**
1. Test resize at multiple speeds (slow drag, rapid drag, maximize/restore) in a manual spike
2. Check ConPTY resize documentation and known issues
3. Verify FitAddon waits for web fonts to load (`document.fonts.ready`) before first fit
4. Look at VS Code's integrated terminal implementation (open source) — how they debounce resize events
5. Check xterm.js issues tagged `resize`, `conpty`, `fit-addon`

**Acceptance.** Recommendation on debounce interval (e.g., 150ms), font-ready wait pattern, and whether any resize edge cases require workarounds. Confirmed-working resize flow documented in code comments.

**Findings.** _(pending)_

---

### R6 — React state management choice

**Question.** What state management approach should Choda Deck use for sidebar state, active project, per-project session map, per-project UI state, and V2+ features (memory panel, task list, ADR editor)?

**Why it matters.** State management decisions are sticky. Migrating from `useState + prop drilling` to `Zustand` or `Redux Toolkit` costs real refactor hours once the codebase has grown. MVP has 3-5 state slices; V2 will have 15-20. Wrong choice now = painful V2.

**Options to evaluate:**

| Option | Pros | Cons |
|---|---|---|
| `useState + props` | Zero deps, familiar | Prop drilling nightmare at N>5 components |
| `useContext + useReducer` | Built-in, no deps, standard React | Re-render cascades if contexts are coarse; verbose for V2 scale |
| **Zustand** | Tiny (~1 KB), hooks API, no boilerplate, selectors prevent re-renders, used by popular apps | Less ecosystem than Redux, team must know it |
| Redux Toolkit | Mature, time-travel debugging, huge ecosystem | Boilerplate, overkill for solo developer |
| Jotai / Recoil | Atomic state, fine-grained re-renders | Smaller community, learning curve |

**What to investigate:**
1. Survey of popular Electron + React apps on GitHub — what do they use?
2. Zustand documentation and read a few non-trivial codebases using it
3. Specific question: can each option handle the case "N xterm instances mounted, only 1 visible, and each can trigger state updates independently without causing cascades"?
4. Benchmarks for re-render cost under V2-like scale (20 state slices, 10 components subscribing)

**Acceptance.** A recommended library with justification, a migration path if we ever need to change later, and a minimal example showing how the sidebar + tab state + session map would be structured.

**Findings.** _(pending)_

---

### R11 — PATH handling for spawned claude CLI

**Question.** When Choda Deck spawns `claude` via node-pty, what does the child process's PATH look like, and will `claude` (or `claude.cmd` on Windows) resolve correctly for users who installed the CLI through different methods?

**Why it matters.** The spike works because Butter installed claude via `npm install -g` and `%APPDATA%\npm` happens to be in PATH. OSS users will install claude via:
- `npm install -g @anthropic-ai/claude-code` (most common)
- Standalone installer or scoop (Windows)
- Homebrew (macOS)
- Yarn global
- Manual extraction to custom directory

If Choda Deck inherits `process.env.PATH` from Electron's main process, the child's PATH equals Electron's PATH. But Electron on Windows can have different PATH than a normal user shell (e.g., missing user-specific entries). And users starting Choda Deck from a shortcut vs from a terminal may have different env.

**What to investigate:**
1. What does `process.env.PATH` actually contain inside an Electron main process on Windows when launched by double-click vs from shell?
2. Best practices for "shell environment" resolution in Electron apps — is there a library (like `shell-env` or similar) that normalizes?
3. Check how VS Code (Electron) handles spawning developer tools
4. Fallback strategy: if `claude` isn't found in PATH, scan common install locations (npm global, scoop dir, Homebrew) and prepend to child's PATH
5. Configuration escape hatch: allow user to specify `shell` path in `projects.json` per project (already partially in our spike config model)

**Acceptance.** A documented PATH resolution strategy (possibly with fallback scan), test cases covering 3+ install methods, and a clear error message when claude truly isn't found.

**Findings.** _(pending)_

---

### R9 — Vault integration pattern (V2+)

**Question.** For Choda Deck's V2+ big-picture features (PARA sidebar, memory panel, task list view, ADR editor, daily note surface), how should the app read and write the Obsidian vault directory?

**Sub-questions:**
- Read-only snapshot vs live watch with chokidar?
- Write-back: direct file edits, or "draft in app → open in Obsidian for final" pattern?
- Markdown parser: `remark` + `remark-wiki-link` (+ plugins for frontmatter, tables) vs custom lightweight parser?
- How to reconcile concurrent edits (user edits in Obsidian while Choda Deck has the file open)?
- Wikilinks across files — do we build an index on startup and keep it in memory?
- Tags, dataview queries, templates — support any of these?

**Why it matters.** Gets V2 architecture right on day 1 of V2 build. Choosing wrong parser or sync model means rewriting the feature surface.

**What to investigate:**
1. Obsidian plugin API docs — what do existing plugins do?
2. `remark` + `unified` ecosystem — plugin list for wiki-links, frontmatter, footnotes
3. Open source tools that read Obsidian vaults externally (e.g., Dataview, Logseq interop tools)
4. Concurrent edit strategies — CRDTs, file locks, optimistic merge
5. Performance: parsing 500+ markdown files on startup vs lazy parse on click

**Acceptance.** A proposed architecture with reference implementation links, parser choice, sync model, and migration path if we change later.

**Findings.** _(pending)_

---

### R10 — Claude CLI auth state detection (V2+)

**Question.** Can Choda Deck detect that a running `claude` session has lost authentication (token expired, API key rotated, network auth failure) so the UI can surface a "re-auth needed" banner instead of silently failing?

**Why it matters.** V2 reliability. A user mid-conversation with claude suddenly getting rejected with an auth error is confusing if the tab just shows the error text and nothing else. Surfacing it at the Choda Deck level (banner, notification, redirect to auth flow) is a better experience.

**What to investigate:**
1. Claude CLI source (if public) or docs for auth error signals (stderr patterns, exit codes)
2. Whether claude CLI has a health-check subcommand (`claude status`?) or lightweight API call
3. How Anthropic's auth flow works — token refresh, expiry timing
4. Does claude CLI exit on auth failure, or keep running with an error state?
5. Could Choda Deck run a periodic `claude --version` or similar heartbeat to detect broken state?

**Acceptance.** A detection mechanism + UX proposal (banner wording, action buttons, how to recover without losing conversation).

**Findings.** _(pending)_

---

### R14 — Context injection into running claude session (V2+)

**Question.** How to programmatically inject vault context (today's daily note, a specific task file, a memory snippet, a skill rules file) into a running `claude` session without restarting it?

**Why it matters.** This is the key enabler for the big-picture vision item "context injection into claude sessions" — the moment Butter clicks a project and the claude in that tab already knows today's plan, the active tasks, and the recent decisions without Butter having to paste anything. This is one of the biggest productivity wins of Choda Deck over raw Claude Code.

**Options to investigate:**

- **Stdin pipe with bracketed paste** — send text via pty write, wrapped in bracketed paste escape codes so claude treats it as a single paste event
- **Initial prompt argument** — pass vault context as the initial message when spawning claude (flag like `-m` or similar if it exists)
- **Slash command** — does claude have `/context <file>` or `/load` or similar to pull in external context?
- **Conversation API direct** — bypass claude CLI entirely, use Anthropic API directly, manage conversation state ourselves (this is a huge scope bump)
- **Filesystem handoff** — write context to a vault-known location, prompt claude "read file X and consider it your starting context"

**What to investigate:**
1. Claude CLI slash command list — is there anything for external context?
2. Claude Code docs on context loading, CLAUDE.md, auto-loading mechanisms
3. Search: "claude code inject context programmatically"
4. Does claude recognize bracketed paste? How does it render long pastes?
5. Proof-of-concept: can a node-pty test script feed a multi-line chunk into claude and have it respond naturally?

**Acceptance.** A working mechanism (code reference + test transcript) with clear UX for "when to inject" and "what to inject" left to the V2 design round.

**Findings.** _(pending)_

---

## Notes

- This backlog is expected to grow as MVP build surfaces new unknowns. Add new items as `Rnn` (next free ID), status `open`.
- Items may depend on each other — flag dependencies in the item body if so.
- The `schedule` skill is used to run a daily or on-demand investigation pass — see `.claude/triggers/` or the scheduled triggers list for current automation.
- Findings must cite sources (URLs, file paths, commit hashes) so a future Choda session can verify independently.
