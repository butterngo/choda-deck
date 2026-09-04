---
type: gotcha
title: highlight.js marks nothing on many real lines — never build interaction on its spans
projectId: choda-deck
scope: project
refs:
  - path: docs/knowledge/ADR-033-deprecate-graphify.md
    commitSha: f8dad2a57f08e23a4a33b7413432f75ece6d00bc
createdAt: 2026-09-03
lastVerifiedAt: 2026-09-03
affectedFeatureId: feature-companion-ui
---

**Trigger:** you plan to attach behaviour — click targets, hover cards, links — to the
`<span class="hljs-…">` elements the syntax highlighter emits, and you verify the plan against a
mocked highlighter or a hand-picked example line.

## Context

`SourceView` (choda-deck-companion, `packages/web/src/components/SourceView.tsx`) highlights per
line via highlight.js and injects the result with `dangerouslySetInnerHTML`. TASK-1798 planned to
wrap those spans to make identifiers clickable. The plan was written into the task body at
planning time and looked obviously correct.

It is not. Run the requirement's own line through the **real** highlighter:

```
input : .AddEndpointFilter<Auth.ServiceTokenWorkspaceFilter>();
output: .AddEndpointFilter&lt;Auth.ServiceTokenWorkspaceFilter&gt;();
```

`.cs` maps to `csharp` (`lib/highlight.ts:26`) and the grammar loads. highlight.js simply marks
**nothing** in that line — no keyword, no type, no span at all. Whole categories of real code
come back as bare escaped text: call chains, generic arguments, member access.

## Business rule

Highlighter output is a **colouring** hint, not a tokenisation. Its span coverage is
grammar-dependent, line-dependent, and not a contract. Any feature that needs to know *where the
identifiers are* must tokenise the text itself.

## Resolution

TASK-1798 produces its own click targets: parse each line's HTML, walk its **text nodes**, and
wrap identifier runs in `<span data-symbol="Name">` (`packages/web/src/lib/symbols.ts`). Walking
text nodes rather than regexing the string is what stops `class="hljs-title"` being wrapped as
two identifiers, and re-serialising escaped text cannot revive a `<script>` from the source file.

**The test rule that follows from this:** do NOT mock the highlighter when testing anything built
on its output. A mock obligingly produces spans, and the test then passes against markup that
never occurs in production. `SourceViewSymbols.test.tsx` runs the real highlighter for exactly
this reason, and its fixture is the line above.
