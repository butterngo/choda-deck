# Decision — two fence finders stay, and a disagreement becomes both visible and unusable

**TASK-1943** · decided 2026-09-14

**Decision: keep the duplication, and adopt options 1 AND 3 together.**

- **Option 1 — a shared fixture with a pinned expectation.** Both repos check in
  the same markdown and assert the same fence table. A drift reddens a build.
- **Option 3 — the client sends the fence TEXT and the adapter refuses a
  mismatch (409).** A drift cannot be acted on, even by a client that is a
  version behind.

Option 2 (the adapter returns the fences) was rejected.

---

## 1. What the problem actually is

`listMermaidFences` exists twice, in two repositories that cannot import each other:

| | |
|---|---|
| authority | `choda-deck/src/adapters/companion/mermaid-check.ts` |
| copy | `choda-deck-companion/packages/web/src/lib/mermaid-fences.ts` |

`fenceIndex` in every `POST /workspace-docs/diagram` means the **adapter's**
index. If the two ever disagree about what counts as a fence, the reader selects
diagram 2 on screen and the model is asked to rewrite a different one. Nothing
errors, nothing logs, and the resulting diff looks like the model behaved oddly.
The damage surfaces later, in a document nobody was watching.

**The duplication is not the defect.** Two runtimes genuinely cannot share this
code today. The defect was that a disagreement had no way of being noticed.

## 2. Why both options, not one

They fail in opposite directions, and each covers the other's blind spot.

| | option 1 (fixture) | option 3 (text precondition) |
|---|---|---|
| catches drift | at **build** time, before release | at **request** time, in the field |
| tells you *which side* drifted | yes — the failing repo is the drifted one | no |
| protects an **old client** against a new adapter | no | no (it sends no text) |
| protects a **new client** against any adapter | no | yes |
| cost | one fixture, two test files | one optional field, one branch |

A build check cannot help a user whose client is a release behind. A runtime
refusal cannot tell a developer which implementation moved. Shipping only one of
them leaves a real hole, and both are cheap.

## 3. Why option 2 was rejected

Having the adapter return the fences would delete the second implementation
outright, which is genuinely attractive. It was rejected on three counts:

1. **The client needs fences before it has asked the adapter for anything.** The
   Docs pane lists diagrams and offers an Edit button per fence *while rendering
   the document it already holds*. Under option 2 that list waits on a round
   trip, and the pane would show a document with no diagrams for the duration.
2. **It moves the coupling rather than removing it.** The client still has to
   agree with the adapter about line ranges in order to splice a saved fence back
   into the markdown (`replaceFence`). Only the *finding* is centralised; the
   *meaning* of a range still lives in two places.
3. **It is the largest change of the three** — a route contract, a new client
   state, and a migration for the shipped app — to solve a problem that options 1
   and 3 together already close.

Option 2 remains the right long-term shape if the fence list ever needs to carry
something only the adapter knows (a parse verdict per fence, say). It is not
needed for this.

## 4. The cost, stated rather than buried

**Keeping the two files in sync is manual.** That is the honest cost of keeping
the duplication, and it is why the fixture test exists — the sync is manual, but
a *failure* to sync is not silent.

**The precondition is OPTIONAL on the wire.** A client that sends no `fenceText`
is served exactly as before. Making it required would break the shipped 0.12.6
app against a newer adapter — a worse failure than the one being fixed. The
consequence is plain: **an old client keeps the old exposure.** That is a
deliberate trade, not an oversight, and it resolves itself as clients update.

**The fixture pins real behaviour, not ideal behaviour.** Fence 4 in it is an
empty fence and yields `start: 66, end: 65` — a start after its end. That looks
like a bug. Pinning it is still correct: the purpose is to make the two
implementations *agree*, and pinning a tidied-up version would redden both sides
while proving nothing about their agreement. If that range is wrong, it is wrong
identically in both, and fixing it is a separate change to both files at once.

## 5. What was built

**choda-deck**
- `src/adapters/companion/__fixtures__/fence-agreement.md` — the shared fixture.
  Seven blocks, each a case the two could plausibly answer differently: indented
  marker, trailing spaces on the marker, a non-mermaid fence, a body containing
  the word `mermaid` and a tilde fence, an empty fence, a fence closing on the
  final line. Its own prose mentions ```` ```mermaid ```` inside a sentence,
  which must **not** count — a substring count says 7 where the truth is 6.
- `src/adapters/companion/fence-agreement.test.ts` — the pinned table, 4 tests.
- `src/adapters/companion/mermaid-check.ts` — the `fenceText` precondition. 409,
  and **before** the provider is called: a refusal that still spent money would
  be worse than the bug.
- `src/adapters/companion/fence-text-precondition.test.ts` — 5 tests over the
  real route, asserting the provider call count rather than only the status.

**choda-deck-companion**
- `packages/web/src/lib/__fixtures__/fence-agreement.md` — byte-identical copy
  (sha256 `e705fe239f9fe4304a55da0adc626211c5d31f635f94cbcdb49bd60fba12f34d`).
- `packages/web/src/lib/__tests__/fence-agreement.test.ts` — the same pinned table.
- `api.ts` — `fenceText` on the request, and a `fence-mismatch` failure kind.
- `FenceEditor.tsx` — sends `fence.code` verbatim; a 409 renders as "reload the
  document", not as a model failure. A reader told "the model failed" would press
  again against a disagreement that never resolves.
- `packages/web/src/components/__tests__/fence-mismatch.test.tsx` — 4 tests.

## 6. Proof it can fail

Both mechanisms were injected against, not merely written:

- **Fixture (AC-2):** narrowing the client's regex from `/^\s*```mermaid/` to
  `/^```mermaid/` — i.e. dropping indented fences — took the client's count from
  6 to 5 and reddened two tests, naming the count and the table. The adapter's
  suite stayed green, which is correct: each repo's build catches its own drift.
- **Precondition (AC-3):** a request naming `fenceIndex: 1` with the body of
  fence 0 is answered 409, with **zero** provider calls and the file unchanged.
  The control — the same index with the matching body — is served, and the
  recorded request proves the model was asked about `SECOND-->B` and not
  `FIRST-->A`.

## 7. If you are here because a fence test went red

Something drifted. Work out which side, then fix the implementation — **do not
edit the pinned table to match.** Changing the expectation to agree with the new
behaviour is exactly the failure this ticket exists to prevent, performed by hand.

If the change is intentional (a genuine improvement to fence-finding), it must
land in **both** implementations and the table updated in **both** repos, in a
change that says why.
