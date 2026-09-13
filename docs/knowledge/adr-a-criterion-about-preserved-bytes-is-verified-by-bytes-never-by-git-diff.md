---
type: decision
title: "ADR: a criterion about preserved bytes is verified by bytes, never by git diff"
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/workspace-docs.ts
    commitSha: 867df4b0aec9a08fd36582ebf3ebeefe19327389
  - path: src/adapters/companion/atomic-file.ts
    commitSha: 867df4b0aec9a08fd36582ebf3ebeefe19327389
createdAt: 2026-09-12
lastVerifiedAt: 2026-09-12
---

> **Status: proposed.** Drafted from a memory during TASK-1931's harvest, awaiting Butter's ratification. It is not yet a ruling.

## Context

Several criteria across this project turn on a writer being *byte-faithful* — saving a file without converting line endings, stripping a UTF-8 BOM, or re-encoding text the human did not touch. `PUT /workspace-docs` and `PUT /claude-config` both make that promise, and both have criteria written to check it.

The natural phrasing for such a criterion is *"run `git diff` — only the edited lines appear as changed"*. TASK-1931 AC-11 was written that way, and so was TASK-1938 AC-2.

That phrasing is unsound here, and it fails silently.

## Decision

**A criterion that asserts bytes were preserved must be verified against the bytes.** `git diff` is not admissible as the proof.

Concretely, such a criterion must be discharged by at least one of:

- a hash comparison (`sha256`) of the file before and after;
- a byte comparison (`Buffer.compare`, `cmp`);
- direct inspection of the properties at issue — `od -An -tx1 -N3` for a BOM, a CR count for line endings.

`git diff` may be shown alongside as a readability aid. It may not be the evidence.

Where a criterion's wording already names `git diff` and cannot be edited (a locked task body), it may be discharged against the byte check with the discrepancy recorded in the `ac_check` evidence — judge the criterion's requirement, not its literal tooling.

## Rationale

Every repository on this machine runs `core.autocrlf=true` with no `.gitattributes`. Git therefore normalises line endings on both sides before diffing, and the damage the criterion exists to detect becomes invisible.

Measured 2026-09-12:

```
experiment:  rewrite EVERY line ending CRLF->LF, plus edit a single line
git reports: 1 file changed, 1 insertion(+), 1 deletion(-)
a perfect
byte-faithful
save reports: 1 file changed, 1 insertion(+), 1 deletion(-)
```

Pass and fail are indistinguishable. A criterion in that state cannot fail, and a criterion that cannot fail certifies nothing while looking rigorous — which is worse than having no criterion, because it is recorded as proof.

## Consequences

- **Existing criteria phrased this way are suspect.** TASK-1938 AC-2 is the known live example and should be discharged by bytes when it is walked.
- **A verification fixture must be shown able to fail before its pass is trusted.** TASK-1931's fixture (`core.autocrlf=false` plus `*.md -text`, content CRLF with a BOM) was demonstrated to report 11 changed lines under a normalising save against 1 under a faithful one, and only then was its pass accepted.
- **This generalises past line endings.** Any criterion whose pass and fail produce identical observable output is theatre; git's normalisation is one instance of a broader failure, not a special case.

## Refs

- `src/adapters/companion/workspace-docs.ts` — the byte-faithful PUT this protects
- `src/adapters/companion/atomic-file.ts` — `writeAtomic`, shared with `/claude-config`
