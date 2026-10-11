# TASK-2384 — AC verification

"Đang chờ anh" (INBOX-2108): Claude Code sessions that finished a turn or wait for a
permission/answer, shown on the decide screen under the daily-digest block.

- Adapter: `src/adapters/companion/attention.ts`, `GET /attention` — choda-deck PR #342
  (`6d38742`), CI green before merge.
- Companion: `views/DecideView.tsx` block + `hooks/use-attention.ts` — companion PR #178
  (`3e6e59d`), no CI in that repo.

## Done — 2/3

| # | Criterion | Evidence |
|---|---|---|
| 0 | Route: fresh sessions oldest first, 13 h old dropped, workspace by cwd or null | `attention.test.ts`: waiting 5 min, unknown cwd 2 min and finished 1 min sessions come back in that order; the 13 h file is dropped; a companion subfolder maps to `choda-deck-companion`, an unknown folder to null; `choda-deckX` does not match `choda-deck`. **Live** after the service restart: `GET /attention` returned a real session in `headless-cms` waiting since 13:31 local |
| 1 | Decide screen: sessions block below digest, above improve, with state and age; absent when none | `decide-view.test.tsx`: block order by DOM position; row "headless-cms … chờ quyền / câu trả lời 4 phút"; no sessions → no block |

## Needs a human — 1

Seeing a real finished session on the decide screen in the app (TASK-2391).

## Findings

- **Lint caught two real bugs from a scripted edit**: the folder-name regex had lost its
  backslash (`/[\/]/`), so a Windows path with no workspace would have shown in full, and the
  test path had lost its backslashes too. Both are fixed, and a new test now fails against the
  broken regex.
- The decide screen now shows sessions even when no inbox item is pending (the empty state needs
  both lists empty). The landing redirect still keys on inbox items only.
