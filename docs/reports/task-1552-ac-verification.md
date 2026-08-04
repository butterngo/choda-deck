# AC verification — TASK-1552: Live-verify capture provenance after a same-tab navigation

**Verdict:** 6/6 verified · task moved to DONE
**Date:** 2026-07-31 · **Session:** SESSION-1785470990446-69 · **Commit:** `5dceb68` (PR #228)

TASK-1551 shipped the fix with 4 of 5 ACs met; the live check needed a signed-in
Chrome and was carried forward as this task. This report covers that check.

---

## 1. Summary

| # | Criterion | Class | Verdict | Proof |
|---|-----------|-------|---------|-------|
| 1 | Image path — Source names the grab page after same-tab nav | human | ✅ | PNG shows the workflow editor; Source names that same `/edit` page |
| 2 | Text path — same, via Grab text | human | ⚠️ | Accepted on testimony first; artifact surfaced after and corroborates |
| 3 | Hand-typed text uses the send-time page | human | ✅ | Source is *not* the last-grabbed page — stale stamp ruled out |
| 4 | Pasted image does not inherit the grab stamp | human | ✅ | Pixels show ichiba; Source reads `cohere.com` |
| 5 | Restricted `chrome://` page | human | ⚠️ | Behavior correct; the AC's `unknown` wording was wrong at filing |
| 6 | Failed `init()` bind no longer reports `unknown` | human | ⚠️ | Reconfirms the repaired path; the race has no deliberate trigger |

✅ proven · ⚠️ proven with a caveat · ❌ failed · ⛔ blocked · 👤 needs a human

**Class split: 0 machine, 6 human.** Every criterion required a signed-in Chrome
side panel, which is not automatable. The server half was driven independently
(§6, steps 2–4) but proves only rendering, not stamping.

---

## 2. Done — what is proven

**AC-1 — image path.** `CONV-1785486085981-23`, event `EVT-1785486190134-70`.
Grab on a workflow editor, same-tab navigation, Send. Title and Source both name
`.../workflows/e8279ab7-b950-4e10-b65a-716388556aee/edit`.
*Discriminator:* the artifact `captures/52937dc16a39188b.png` shows the editor
canvas. Had the grab happened on the list page and the stamp leaked from the
post-navigation page, the pixels would show a list while the Source said `/edit`.
Pixels and Source agree on *editor*, which the failing implementation could not
produce.

**AC-3 — hand-typed fallback.** `CONV-1785486743145-27`, event `EVT-1785486812312-72`.
Body `test AC-3 fallback"` carries no `# <document.title>` prefix, so it is typed
rather than grabbed.
*Discriminator (negative):* Source is **not** `cohere.com/blog/embed-4`, the most
recently Grab-text'd page. A leaked `textSourceUrl` would have named Cohere. It
named the live tab instead, and not `unknown` — so the fallback branch fired.

**AC-4 — paste does not inherit.** `CONV-1785487041723-31`, event `EVT-1785487079471-73`.
Grab on `/edit`, navigate to `cohere.com`, paste a clipboard image, Send.
*Discriminator:* `captures/52eadabfeac32797.png` shows the ichiba desktop —
browser chrome and the Choda panel are in frame, so it is clipboard content, not
`captureVisibleTab` — while Source reads `cohere.com/blog/embed-4`. Pre-fix, the
pasted image would have inherited the `/edit` stamp.

---

## 3. Not done — what is NOT proven

**Failed:** none.

**Not run:** none. All six were exercised.

**Proven with a caveat — three:**

**AC-2** was ticked on Butter's confirmation before any artifact existed, and the
evidence string says so. `CONV-1785486653028-25` surfaced afterwards and
corroborates it (body `# Introducing Embed 4 | Cohere Blog` matches Source
`cohere.com/blog/embed-4`). The evidence was deliberately **not** backdated —
rewriting it to cite the artifact would hide that the tick rested on testimony.

**AC-5** passes in substance and fails in wording. It demands Source read
`unknown`; it reads the real URL `chrome://extensions/?errors=idldbo…`. That is
strictly more accurate and satisfies the criterion's actual requirement — *"rather
than a stale or wrong URL"*. `unknown` was never reachable: `resolveTabSource`
returns it only when `tabs.query` fails or the tab has no url, and the extension
holds the `tabs` permission. **The AC text should be corrected.**

**AC-6** reconfirms the repaired path rather than observing a repair. The original
`init()` failure was a race with no user-reachable trigger, so it cannot be forced.
Supporting evidence: 7 captures this session, none reporting `unknown`, against the
defect artifact `CONV-1785332788516-7` titled *"Screenshot from unknown"*.

---

## 4. Blockers — what stopped verification

**None blocked the final result.** One was hit and resolved:

- **Chrome side panel is not automatable** and needs a signed-in profile. First
  reported verdict was BLOCKED. Resolved by splitting the surface: the server half
  was driven directly over HTTP; the panel half was run by the user with artifacts
  read back for scoring.

---

## 5. Needs a human — what could not be self-driven

All six criteria. The pattern for any future run:

**Preconditions — skipping either invalidates every result:**
1. Reload the extension at `chrome://extensions` (a stale service worker keeps the
   old `popup.js`).
2. Reload the **page** (content scripts are not re-injected into open tabs).
3. Set the panel's project dropdown — `payload.projectId` comes from it, so
   evidence otherwise files itself under the wrong project.

**Per criterion:**

| AC | Sequence |
|----|----------|
| 1 | Grab screenshot on page A → navigate same tab to page B → Send |
| 2 | Grab text on page A → navigate same tab → Send |
| 3 | Clear any grab → type text by hand → Send |
| 4 | Grab on A → navigate to B → paste clipboard image → Send |
| 5 | Focus a `chrome://` tab → type by hand (Grab fails there) → Send |
| 6 | Reload extension → open a fresh panel → Grab immediately → Send |

Choose page A and page B so they are **visibly different**, otherwise the result
cannot distinguish pass from fail (see §6, rejected attempts).

---

## 6. Steps — what was actually done

1. **Scope.** `git diff 5dceb68~1..5dceb68` — read the source diff, not the task's
   description of it. 3 source files, 16 knowledge files.
2. **Found the surface.** Server half = `POST /capture` on the companion; panel
   half = the Chrome side panel. Companion confirmed up: `/healthz` → `{"ok":true}`.
3. **Drove the server half.** Bridge token from `data/bridge-token.txt`. A supplied
   `sourceUrl` renders verbatim into both title and the Source line
   (`CONV-1785485716647-13`).
4. **Probed it.** `sourceUrl: "unknown"` renders as-is, no substitution
   (`CONV-1785485716701-15`). `sourceUrl` omitted →
   `{"error":"sourceUrl must be a non-empty string"}`, nothing created — the
   dispatcher will not invent an origin.
5. **Reported BLOCKED.** Steps 3–4 prove rendering, not stamping — which is the
   whole change. Handed the panel half to the user.
6. **Rejected three early captures.** `CONV-…-7` was taken pre-reload (old
   `popup.js`). `CONV-…-9` and `-11` were network captures — a different code path,
   already verified under TASK-1549.
7. **Rejected the first AC-1 candidate.** Title and Source agreed, but that is
   exactly what the old bug produced. Resolved by reading the PNG instead of asking
   for the click order.
8. **Rejected the first AC-4 attempt** (`CONV-1785486910422-29`). Grab page and send
   page were both `/edit`, so an inherited stale stamp and a correct send-time read
   emit byte-identical output. **The test could not fail.** Re-run with `cohere.com`
   as page B.
9. **Ticked 1, 3, 4** on artifact-internal discriminators; **2** on testimony
   (later corroborated); **5** with the wording correction recorded; **6** with the
   un-forceable-race limitation recorded.
10. **Corrected an earlier claim of my own.** I had flagged captures landing in
    project `automation-rule` as a defect. It is not — `projectId` comes from the
    panel's dropdown. Flagged so it would not be chased.

---

## 7. Findings

- ⚠️ **`inject.js` console wrapper destroys source-location attribution**
  (`INBOX-1641`). Found mid-run from a pasted stack trace: AG Grid's license warning
  topped out at `inject.js:119 (console.<computed>)` instead of
  `index-DHOCCho_.js:292`. Affects every `console.error`/`warn` on every page,
  always — the wrapper installs at document load regardless of whether the panel is
  open. Its own comment at `inject.js:105` claims "nothing observes a behavior
  change", which is false. No fix by tweaking the wrapper; monkey-patching `console`
  always inserts a frame.
- ⚠️ **AC-5 was unsatisfiable as written** — see §3. Worth correcting in the task
  body so the next reader does not think `unknown` is expected behavior.
- **Pasted captures carry a misleading title.** `CONV-…-31` reads *"Screenshot from
  cohere.com"* while the pixels are ichiba. Correct by design (clipboard content has
  no origin) but the label reads as a factual claim about the image — the same
  misleading-provenance class TASK-1549/1551 exist to prevent (`INBOX-1643`).
- **Grab text swallows the whole page** — cookie banner, nav, footer: roughly 10KB of
  boilerplate around the actual article (`INBOX-1644`).
- **Evidence lands in the wrong project** when the panel dropdown is not set first.
  `CONV-…-17` went to `automation-rule`, `CONV-…-25` to `juvenis-maxime` with no
  session link at all. Not a bug — but it silently scatters the proof.
- The Graph bearer token captured in `CONV-1785474416342-11` has expired but remains
  in the DB in plaintext (already filed as `INBOX-1612`).
- Two throwaway conversations from driving `/capture` directly remain in `choda-deck`
  (`CONV-…-13`, `-15`). No delete tool exists for conversations; `session_end` closed
  them.

---

## Method note

Three of six criteria were tickable only because the artifact carries a
**discriminator** — a payload the code under test did not author, capable of
contradicting the field being checked. Screenshot pixels are the grab moment
frozen; `grabText`'s `# <title>` prefix comes from the grabbed page. The operator's
recollection of the click order was deliberately not relied on for those.

The trap this run kept surfacing: **title and Source agreeing feels like
corroboration and is not.** They are two renderings of one value — when it is
wrong, they agree just as confidently.

Recorded as `docs/knowledge/a-live-verification-needs-a-discriminator-if-pass-and-fail-look-identical-the-te.md`.
