---
type: gotcha
title: A component gaining a hook reddens every test whose fake never named it — and the error names the wrong thing
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-09-03
lastVerifiedAt: 2026-09-03
affectedFeatureId: feature-companion-ui
---

**Trigger:** you add a hook to an existing companion view — a second `useQuery`-backed hook
beside one already there — and an unrelated test file goes fully red with
`No QueryClient set, use QueryClientProvider to set one`.

## Context

Companion view tests mock the hooks the view uses, not the network. When the view acquires a NEW
hook, the old test file still mocks only the old one, so the real hook runs inside a render tree
that has no `QueryClientProvider`. Every test in that file dies — and it dies naming a query
client, which points at test infrastructure rather than at the dependency that actually changed.

Observed twice, in the same shape:

| Change | Test file taken down | Count |
|---|---|---|
| `useWorkspaceCommit` added to `WorkspaceView` (TASK-1783) | `workspace-view.test.tsx` | 15 |
| `useWorkspaceSymbols` added to `WorkspaceDocsView` (TASK-1798) | `workspace-docs.test.tsx` | 15 |

Filed as INBOX-1892 and again as INBOX-1899 — the second filing exists because the first one
changed nothing.

A worse variant exists and is worth knowing about: when the fake is an `as unknown as` cast,
widening the interface it stands for breaks it at **runtime with typecheck still green**
(INBOX-1892's original report, on the task-detail fake). Nothing reports that one; it surfaced
only because a test happened to assert on the field that went empty.

## Business rule

A test that mocks *any* of a component's hooks has taken responsibility for *all* of them. The
mock set is a silent contract with the component's import list, and nothing in the toolchain
enforces it.

## Resolution

When adding a hook to a view, grep for test files mocking that view's other hooks and add the new
one to each. The fix is mechanical; the cost is that you only learn you needed it from a failure
that names something else.

Open question, not yet decided (INBOX-1899): whether these fakes should be derived from the
hook's return type so the compiler sees the gap, or whether a lint rule should require that a
file mocking one hook of a component mocks all of them. Until then this stays a manual habit.
