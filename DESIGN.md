# Choda Deck — DESIGN.md

> Desktop orchestrator for Claude Code sessions. Sidebar per project, main pane hosts polymorphic views (Board, Terminal, Activity, Wiki). Windows-first Electron app, dark-theme native.

---

## 1. Visual Theme & Atmosphere

**Mood:** Editor-native. Built to sit beside VS Code and xterm without visual context switch. No marketing polish, no rounded flourishes — every pixel earns its place.

**Density:** High. A developer workspace, not a consumer app. Sidebar collapses to 36 px. Tasks list 40 px rows. Task cards stack at 8 px gaps. Information density over whitespace.

**Philosophy:**
- **Dark-only** — no theme switcher (MVP fixed on `#1e1e1e`). Theming deferred to V2+.
- **IDE semantics** — active = #094771 (VS Code Dark+ selection blue). Hover = #2a2d2e. Borders = #333 / #3d3d3d.
- **Monospace where it matters** — IDs, paths, code. System sans elsewhere.
- **Zero animation** beyond cursor blink and 120 ms hover transitions. No spring physics, no skeleton shimmers.

---

## 2. Color Palette & Roles

| Token | Hex | Role |
|---|---|---|
| `--bg-canvas` | `#1e1e1e` | Root background, sidebar, terminal |
| `--bg-surface` | `#252526` | Modals, cards, detail panels |
| `--bg-raised` | `#2d2d2d` | Message bubbles, hover states, chip background |
| `--bg-hover` | `#2a2d2e` | Sidebar item hover |
| `--bg-active` | `#094771` | Selected project / active tab underline origin |
| `--border-subtle` | `#2d2d2d` | Card internal dividers, section separators |
| `--border-default` | `#333` | Sidebar right border, input outlines |
| `--border-strong` | `#3d3d3d` | Modal borders, icon button outline |
| `--border-focus` | `#5d5d5d` | Icon button hover border |
| `--fg-primary` | `#d4d4d4` | Body text, default foreground |
| `--fg-strong` | `#fff` | Active labels, modal titles |
| `--fg-muted` | `#9ca3af` | Meta text, type badges, secondary labels |
| `--fg-subtle` | `#6b7280` | Timestamps, IDs, section titles |
| `--fg-disabled` | `#6b6b6b` | Empty-state copy |
| `--accent-primary` | `#3b82f6` | Tab active underline, link, focus ring |
| `--accent-selection` | `#264f78` | xterm text selection |
| `--status-todo` | `#f59e0b` | Open / todo badge (amber) |
| `--status-doing` | `#3b82f6` | In-progress / discussing (blue) |
| `--status-decided` | `#8b5cf6` | Decided / purple |
| `--status-done` | `#10b981` | Done / active (emerald) |
| `--status-closed` | `#6b7280` | Closed / completed (gray) |
| `--status-danger` | `#ef4444` | Stale / abandoned / delete hover |
| `--danger-bg` | `#7f1d1d` | Destructive button hover fill |
| `--danger-border` | `#991b1b` | Destructive button hover border |

**Role guidance:** Status colors are *semantic* and shared between tasks, sessions, and conversations — a DONE task, a `completed` session, and a `closed` conversation all render in the same gray. Do not invent per-entity palettes.

---

## 3. Typography Rules

| Scale | Size | Weight | Family | Used for |
|---|---|---|---|---|
| `display` | — | — | — | *(none — no marketing surfaces)* |
| `h1` | 18 px | 600 | System sans | Section headers (rare) |
| `h2` | 16 px | 600 | System sans | Modal titles (`deck-activity-panel-title`, `deck-detail-title`) |
| `body` | 13 px | 400 | System sans | Default text, card titles, input |
| `body-sm` | 12 px | 400 | System sans | Meta, message content, decision text |
| `caption` | 11 px | 400 / 600 | System sans | Timestamps, IDs, icon button labels |
| `micro` | 10 px | 600 | System sans | Badges (UPPERCASE, letter-spacing: 0.05em) |
| `code` | 13 px | 400 | Cascadia Code | Terminal (xterm, 14 px), message IDs, file paths |
| `section-label` | 11 px | 600 | System sans | Panel section titles (UPPERCASE, 0.05em tracking) |

**Families:**
- **Sans:** `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` (OS native)
- **Mono:** `'Cascadia Code', Consolas, 'Courier New', monospace`

**Terminal type is locked:** Cascadia Code 14 px, `#d4d4d4` on `#1e1e1e`. No user override until V2+.

**Line height:** 1.5 for prose blocks (`deck-activity-message-content`), 1.2 tight for UI chrome buttons, default otherwise.

---

## 4. Component Stylings

### Buttons

| Variant | Background | Border | Color | Padding | Hover |
|---|---|---|---|---|---|
| **Primary** (`deck-sidebar-btn`) | transparent | 1 px `#333` | `#d4d4d4` | 6 px 10 px | bg `#2a2d2e`, fg `#fff` |
| **Icon chrome** (`deck-sidebar-hamburger`) | transparent | none | `#666` | 28×28, 3 px radius | bg `#2d2d2d`, fg `#d4d4d4` |
| **Add +** (`deck-sidebar-add-btn`) | transparent | 1 px `#333` | `#d4d4d4` | 24×24, 3 px radius | bg `#2a2d2e` |
| **Icon mini** (`deck-activity-icon-btn`) | transparent | 1 px `#3d3d3d` | `#9ca3af` | 2 px 6 px, 11 px text | bg `#2d2d2d`, fg `#fff`, border `#5d5d5d` |
| **Icon danger** | transparent | 1 px `#3d3d3d` | `#9ca3af` | 2 px 6 px | bg `#7f1d1d`, fg `#fff`, border `#991b1b` |
| **Tab** (`deck-tab`) | transparent | none | `#9ca3af` | 8 px 16 px | fg `#d4d4d4` |
| **Tab active** | transparent | — | `#fff` | — | 2 px `#3b82f6` bottom border |
| **Project name** (`deck-sidebar-project-name-btn`) | transparent | none | `#c8c8c8` | 6 px 12 px, 13 px | bg `#2a2d2e`, fg `#fff` |
| **Project active** | `#094771` | — | `#fff` | — | (stays) |
| **Close ×** (`deck-activity-close`) | transparent | none | `#9ca3af` | 0 8 px, 24 px font | fg `#fff` |
| **Banner button** (`deck-banner-btn`) | *inherit banner* | 1 px current | current | 4 px 10 px, 3 px radius | — |

**Rules:**
- Border radius: **3 px** for chrome chips, **4 px** for message bubbles, **6 px** for activity cards, **8 px** for modals. Never use 0 (flat look reads unfinished) and never > 8 (reads consumer).
- No filled primary button. The project is read-heavy; actions are inline icons.
- Hover uses color, not transform or shadow. No `translateY(-1px)` etc.

### Cards

**Activity card** (`deck-activity-card`)
- Background `#1e1e1e`, border 1 px `#2d2d2d`, radius 6 px, padding 10 px 12 px.
- Header row: badge + ID (mono 11 px `#6b6b6b`) + icon buttons + date (right-aligned, 11 px `#6b6b6b`).
- Title 13 px `#d4d4d4`, decision italic 12 px `#9ca3af`.
- `--clickable` variant: border-color 120 ms transition to `#3b82f6` on hover.

**Kanban column** — inherits `--bg-canvas`, with a 1 px `#333` divider on the right.

### Inputs

- Background `#1e1e1e`, border 1 px `#333`, color `#d4d4d4`, 13 px, padding 6 px 10 px, 3 px radius.
- Focus: border `#3b82f6`, no glow, no outline offset.
- Placeholder `#6b7280`.

### Badges (`deck-activity-badge`)

10 px, weight 600, `#fff` text on semantic color, 2 px 6 px padding, 3 px radius, **UPPERCASE**. Shared between task statuses, session states, conversation states.

### Sidebar

- Width 200 px expanded, 36 px collapsed, `0.15s ease` width transition.
- Project list: flat, no expand/collapse arrows (workspace list is hidden in current build).
- Active project row uses `#094771` fill. Inactive hover `#2a2d2e`.
- Header has hamburger (left), title "Projects" (center-left), add `+` and help `?` (right).

### Modal overlay

- Full-viewport `rgba(0,0,0,0.7)` with 4 px backdrop-blur.
- Centered panel `min(900px, 90vw)` × `max-height: 85vh`, `#252526` bg, 1 px `#444` border, 8 px radius, `0 20 px 60 px rgba(0,0,0,0.5)` shadow.
- Close via backdrop click OR `×` button OR ESC (renderer listener).

### Terminal pane

- xterm renders into `.deck-terminal`. Theme fixed: `#1e1e1e` bg, `#d4d4d4` fg, `#264f78` selection. No scrollbar chrome styling (let OS handle).
- Restart banner appears on exit/crash: inline row with colored left border + text + button.

---

## 5. Layout Principles

**Root layout:** `display: flex` two-column — `<aside>` sidebar 200 px fixed + `<main>` flex-1. No nested flexbox gymnastics; views are `position: absolute` within their container when they need to fill (terminal, board).

**Spacing scale (px):** `2 · 4 · 6 · 8 · 10 · 12 · 16 · 20 · 24`. Avoid odd values. 8 px is the default gap. 4 px only for tight chrome (badges, icon button gaps).

**Grid:** None. The app is list-driven, not grid-driven. Kanban columns are flex children, not CSS grid.

**Whitespace:** Minimal. A 12 px padding around card groups is the max. The sidebar has 0 horizontal padding — items are full-bleed with internal 12 px pad. Empty state copy gets 24 px around it to feel intentional, not broken.

**Header bar:** 40 px tall, 1 px `#333` bottom border, title left + project context right (e.g. `Automation Rule / BE — C:\dev\...`).

**Tab bar:** 32 px tall, 8 px horizontal padding-top only, flex gap 4 px. Active tab marked by 2 px `#3b82f6` bottom border (no pill, no fill).

---

## 6. Depth & Elevation

Only three levels. Elevation here means **surface tint**, not shadow.

| Level | Where | Treatment |
|---|---|---|
| **0** (canvas) | Root, sidebar, terminal | `#1e1e1e`, no shadow |
| **1** (raised) | Modals, detail panels | `#252526` + 1 px `#444` + `0 20 px 60 px rgba(0,0,0,0.5)` |
| **2** (chip) | Message bubbles, chips, badges | `#2d2d2d` or semantic color, no shadow |

**Shadows are reserved for modals.** Cards, buttons, and sidebar items never use `box-shadow`. Use border + color to signal elevation.

---

## 7. Do's and Don'ts

### Do
- Use the `.deck-*` class prefix for every new selector. Keeps the bundle greppable.
- Share status colors across domains (task / session / conversation) — semantic consistency.
- Default to `null` for empty refs (`useRef<T | null>(null)`), matching the codebase.
- Mount xterm / long-lived components once per tab, hide via `.deck-terminal--hidden`, never unmount on tab switch.
- Keep icons as Unicode glyphs (`⧉`, `×`, `🗑`, `✓`) — no icon library dependency for MVP.
- Pair monospace with IDs, paths, diffs. Pair sans with titles, meta, buttons.
- Use `confirm()` for destructive actions (current pattern). A custom modal is scope creep.
- Hover state = color change. Active state = color + border change. No scale, no translate.

### Don't
- Don't introduce Tailwind, CSS-in-JS, or a component library. Plain CSS under `assets/deck.css` is the rule.
- Don't add gradients. The brand is editor-native, not marketing-native.
- Don't add box-shadow on cards or buttons. Shadows are for modals only.
- Don't introduce a theme picker before V2. Dark is the identity.
- Don't use Material-style ripple or any motion over 200 ms.
- Don't use emoji inside UI copy unless the user opts in. Status uses badges, not emoji.
- Don't add rounded corners > 8 px. Reads consumer.
- Don't flatten to 0 px radius either — reads unfinished.
- Don't put body copy in mono. Mono is for code, IDs, and paths only.
- Don't use `!important` except for xterm overrides (`.deck-terminal .xterm-viewport { background: #1e1e1e !important }`).

---

## 8. Responsive Behavior

**Target viewport:** 1280–1920 px wide desktop. No mobile, no tablet — Electron on a dev machine.

**Collapsing strategy:**
- Sidebar: 200 px → 36 px via hamburger. No breakpoint auto-collapse.
- Modal: clamps to `min(900 px, 90vw)` × `85vh`. Content scrolls inside.
- Activity list / Kanban columns: scroll internally, never reflow.
- Terminal: xterm owns its resize loop via `ResizeObserver → fitAddon.fit() → pty.resize`. The design doesn't negotiate; the terminal adapts to whatever pixel space it's given.

**Touch targets:** Desktop-only, so minimum touch target does not apply. Buttons can be 24 px or smaller. Keyboard shortcuts (Ctrl+1..9, Ctrl+Tab) are the primary navigation.

**Print, high-contrast, reduced-motion:** Not supported in MVP. Document when V2 adds them.

---

## 9. Agent Prompt Guide

### Quick reference swatch

```
BG          #1e1e1e (canvas)  /  #252526 (surface)  /  #2d2d2d (raised)
BORDER      #333 default  /  #3d3d3d strong  /  #2d2d2d subtle
FG          #d4d4d4 body  /  #fff strong  /  #9ca3af muted  /  #6b7280 subtle
ACCENT      #3b82f6 blue  /  #094771 active-fill
STATUS      amber #f59e0b · blue #3b82f6 · purple #8b5cf6 · emerald #10b981 · gray #6b7280 · red #ef4444
DANGER HOV  bg #7f1d1d  /  border #991b1b
FONT        sans: system-ui  |  mono: Cascadia Code 13/14 px
RADIUS      3 / 4 / 6 / 8 px
SCALE       2 4 6 8 10 12 16 20 24 px
```

### Prompts you can paste into an agent

> **"Build a settings panel matching Choda Deck."**
> Use a modal at `min(900 px, 90vw)` × `85vh`, `#252526` bg, 1 px `#444` border, 8 px radius, `0 20 px 60 px rgba(0,0,0,0.5)` shadow. Header row with status badge + mono ID + icon buttons + close `×`. Body uses section titles in 11 px uppercase `#6b7280` with 0.05em tracking, separated by 1 px `#2d2d2d` top borders and 16 px top margin. Labels 13 px `#d4d4d4`, helper text 12 px `#9ca3af`. Inputs: `#1e1e1e` bg, 1 px `#333` border, 3 px radius, focus border `#3b82f6`. No gradients, no shadows on inputs, no animations over 200 ms.

> **"Build a list card like the Activity cards in Choda Deck."**
> `#1e1e1e` background, 1 px `#2d2d2d` border, 6 px radius, 10 px 12 px padding. Header row (4 px gap): a 10 px UPPERCASE badge on a semantic status color, a mono ID in `#6b6b6b` at 11 px, two icon chip buttons (`⧉` copy, `×` delete) with 1 px `#3d3d3d` border 3 px radius that hover to `#2d2d2d`/fg `#fff`, and a right-aligned date in 11 px `#6b6b6b`. Title below in 13 px `#d4d4d4`. Optional italic 12 px `#9ca3af` meta below title. Hover: border-color 120 ms to `#3b82f6`. No shadow, no translate on hover.

> **"Style a tab bar like Choda Deck's ViewRouter."**
> 32 px tall row, `flex`, gap 4 px, 8 px top padding. Each tab is a transparent button, 8 px 16 px padding, `#9ca3af` text, no border. Hover flips color to `#d4d4d4`. Active tab: text `#fff` + 2 px `#3b82f6` bottom border. No pill, no fill, no icon. Do not animate.

### Anti-prompts (what to refuse)

- "Add a light/dark toggle" → dark-only by design; defer to V2.
- "Add gradient backgrounds / glow / neon" → editor-native brand, refuse.
- "Use Tailwind / shadcn / MUI" → plain CSS under `deck.css` only.
- "Add hover scale / lift animation" → color change only.
- "Round corners to 12 px or more" → max 8 px on modals, 6 px on cards.

---

**File location:** project root (`/DESIGN.md`). Peer to `CLAUDE.md` / `AGENTS.md`. When editing renderer code, consult this file alongside [.claude/rules/react.md](./.claude/rules/react.md) and the actual CSS at [src/renderer/src/assets/deck.css](./src/renderer/src/assets/deck.css).
