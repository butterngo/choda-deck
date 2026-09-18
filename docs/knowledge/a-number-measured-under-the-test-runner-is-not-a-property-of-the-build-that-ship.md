---
type: learning
title: A number measured under the test runner is not a property of the build that ships
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/mermaid-check.ts
    commitSha: af9fc63f231d056cad94c53a1579d3693836b078
  - path: package.json
    commitSha: af9fc63f231d056cad94c53a1579d3693836b078
createdAt: 2026-09-14
lastVerifiedAt: 2026-09-14
---

**Trigger:** you are about to write a measured figure — a latency, a size, a memory number — into a report, a task body, or a decision that turns on it, and you took that figure under vitest, jest, or a dev server.

## Context

The test runner and the shipped artifact are different programs. Vitest resolves dependencies from `node_modules`, un-bundled, module by module. `esbuild --bundle` inlines them into one file. Both run "the same code" in the sense that the source is identical; they do not behave alike, and the gap can be enormous.

## Business rule

**A measurement is a property of the artifact it was taken against.** Attributing a test-runner figure to the product is not an approximation — it can be wrong by orders of magnitude, and wrong in the direction that changes a decision.

Measured 2026-09-13, first `POST /workspace-docs/diagram/check` on a cold process:

```
under vitest (mermaid resolved from node_modules)   ~36 s
bundled adapter (what build:companion emits)        64-71 ms   (3 runs)
the packaged app 0.12.6, port 63994                 80 ms
```

Same source. About 500× apart. The 36 s was real — it was measuring the *external* dependency layout, which is exactly the build option TASK-1941 went on to reject.

## Resolution

Boot the real artifact and measure that. For an adapter: build it, start it as its own process, and drive it over its real protocol. For a packaged app: find the running binary (by port ownership, not by assuming the default port) and hit it.

Say which artifact a figure came from, in the same sentence as the figure. A number without its provenance invites exactly this mistake from the next reader.

## What this cost

The 36 s figure was written into **two** records — `TASK-1931`'s AC verification report and `TASK-1941`'s body — as a property of the packaged app, complete with a proposed mitigation ("warm the import at boot") for a cost the shipped build does not pay. It then sat in the body of the very task meant to decide bundled-vs-external, arguing for the wrong answer.

Checking it against a real process took four minutes.

Both records were corrected rather than deleted, so the mistake stays visible. See `docs/reports/task-1941-bundled-vs-external-decision.md` §4 and `choda-deck-companion/docs/reports/TASK-1931-ac-verification.md` §7.

## Related

- The same principle at a different surface: `git-diff-cannot-prove-bytes-were-preserved-while-core-autocrlf-is-on` — verify against the thing itself, not against a tool's view of it.
- A memory recalled at the start of that very session said *"a number you measured and wrote into a report is not a substitute for looking at the thing."* It was recalled, echoed, and then not applied.
