---
task: TASK-1915
title: Make /choda-plan and /choda-verify-ac actually call the grader
verified: 2026-09-08
session: SESSION-1788867638096-72
run: /choda-burn-backlog iteration 3 — HALTED after this task (§12)
---

# AC verification — TASK-1915

**Done: 1/5. Needs a human: 4. Blockers: none for the change; one for the run (§12).**
Held at IMPLEMENTED, not DONE.

Merged and proven before the tick: choda-skills PR #11, merge commit `730a99f`,
asserted an ancestor of `origin/main`.

## Criteria

| AC | Class | Verdict | Evidence |
|---|---|---|---|
| AC-1 | human | ⬜ not done | Run `/choda-plan` on a parent whose subtask carries a deliberately vague criterion, and check the verdict is shown AND the task is still offered for approval |
| AC-2 | human | ⬜ not done | The CONTROL: run it on sound criteria and check nothing is flagged. Must be run as a PAIR with AC-1 and in that order — either alone passes against a grader stuck on one answer |
| AC-3 | human | ⬜ not done | Count tool invocations over a 3-subtask plan: 3, not 12 |
| AC-4 | human | ⬜ not done | With no provider configured, both skills continue and say the grader is unavailable |
| AC-5 | machine | ✅ | Against the MERGED tree (`git show origin/main:…`): `choda-plan/SKILL.md` names `ac_review` ×10 and "advisory" ×3; `choda-verify-ac/SKILL.md` ×3 and ×3 |

AC-5 was deliberately written to be weak — it proves the text says so, not that a
run behaves so. It exists to catch the wording being dropped in a later edit, and
that is all it is being ticked for.

## Why 4 of 5 cannot be proven here

A skill is prose. There is no harness that runs one, so every criterion about
behaviour needs a person driving a session. Writing a machine-checkable stand-in
would have produced a criterion that passes without the behaviour existing —
which is the defect this whole chain of tasks was about.

The four are not lost: they are the acceptance of a change that is already
merged, and they need one attended session with a restarted MCP server.

## §12 halt — the run stopped here

The skills checkout's local `main` carries a commit this run did not make and
which is not on the remote:

```
3d7a166 feat(requirement-analysis): anchor the discovery loop on a conversation (TASK-1624)
```

Another session is working in the same checkout. Nothing was reset, pushed on its
behalf, or merged. The consequence to know: local `main` could not fast-forward,
so the SKILL.md files **on disk** are the pre-merge versions (0 hits for
`ac_review`) while `origin/main` carries the change. That is a checkout state,
not a state of the change — which is why AC-5 was verified against the merged
tree rather than the working copy.

## Findings

The skills repo has no `typecheck`, `lint`, `test` or `build` script — §6's four
gates do not exist for a prose repo. What replaced them: a diff review, a check
that both new section anchors exist, and a fix to one cross-reference (`§After`,
which pointed at no section, now `§7`).
