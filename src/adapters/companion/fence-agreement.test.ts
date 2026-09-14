// TASK-1943 — the adapter half of a cross-repository agreement.
//
// `listMermaidFences` exists twice, in two repositories that cannot import each
// other:
//
//   authority  choda-deck/src/adapters/companion/mermaid-check.ts   <- this one
//   copy       choda-deck-companion/packages/web/src/lib/mermaid-fences.ts
//
// `fenceIndex` in every POST /workspace-docs/diagram means the ADAPTER's index.
// If the two ever disagree about what counts as a fence, the reader picks
// diagram 2 on screen and the model is asked to rewrite a different one. Nothing
// errors and nothing logs; the damage shows up later in a document nobody was
// watching.
//
// THIS FILE AND ITS TWIN ARE THE DETECTOR. Both repos check in the same fixture
// and assert the same EXPECTED table below. Either implementation drifting makes
// its own repo's build red, which is the whole point: a disagreement must not be
// discoverable only by a user losing an edit.
//
// Keeping them in sync is manual, and that is acknowledged rather than hidden —
// see the decision in docs/reports/task-1943-fence-agreement-decision.md. The
// fixture is deliberately awkward; every block in it is a case the two could
// plausibly answer differently.

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { listMermaidFences } from './mermaid-check'

/**
 * THE PINNED EXPECTATION. Byte-for-byte identical in both repositories.
 *
 * Derived by running the authority against the fixture and recording what it
 * actually said — not by deciding in advance what it ought to say. That
 * distinction matters for fence 4: an empty fence yields start 66 > end 65,
 * which looks like a bug and is simply how an empty range is expressed here.
 * Pinning the REAL behaviour is what makes the two sides agree; pinning an
 * idealised version would make this test fail on both and prove nothing.
 */
export const EXPECTED_FENCES = [
  { index: 0, start: 19, end: 20, code: 'flowchart TD\n  A-->B' },
  { index: 1, start: 29, end: 30, code: '  sequenceDiagram\n    A->>B: hi' },
  { index: 2, start: 39, end: 40, code: 'flowchart LR\n  X-->Y' },
  {
    index: 3,
    start: 55,
    end: 57,
    code: 'flowchart TD\n  N["the word mermaid inside a label"]\n  N-->M["~~~ not a fence"]'
  },
  { index: 4, start: 66, end: 65, code: '' },
  { index: 5, start: 71, end: 72, code: 'flowchart TD\n  LAST-->ONE' }
] as const

const FIXTURE = path.join(__dirname, '__fixtures__', 'fence-agreement.md')

describe('TASK-1943 — cross-repo fence agreement (adapter side)', () => {
  const markdown = fs.readFileSync(FIXTURE, 'utf8')
  const fences = listMermaidFences(markdown)

  it('finds exactly the pinned number of fences', () => {
    // The count alone catches the most likely drift: one side's regex stops
    // matching the indented fence, or starts matching the ```ts block.
    expect(fences).toHaveLength(EXPECTED_FENCES.length)
  })

  it('agrees on every ordinal, line range and body', () => {
    // Compared as one structure rather than field by field, so a disagreement
    // reports WHICH fence moved instead of "expected 39 to be 40".
    expect(fences.map((f) => ({ index: f.index, start: f.start, end: f.end, code: f.code }))).toEqual(
      EXPECTED_FENCES.map((e) => ({ index: e.index, start: e.start, end: e.end, code: e.code }))
    )
  })

  it('does not count the ```ts block', () => {
    // Named separately because it is the one miscount that does NOT shift the
    // ordinals of everything after it — it inserts one, so a reader would edit
    // a TypeScript block believing it was a diagram.
    for (const f of fences) {
      expect(f.code).not.toContain('notADiagram')
    }
  })

  it('the fixture is the one both repos share', () => {
    // A test asserting the pinned table against a fixture that quietly changed
    // is a test agreeing with itself. This pins the fixture's own shape.
    expect(markdown).toContain('This file is checked into TWO repositories')

    // Counted as opening LINES, not as occurrences of the string. The fixture's
    // own prose mentions ```mermaid inside a sentence, and that mention is not a
    // fence — a substring count says 7 where the truth is 6. Getting this wrong
    // once, here, is the cheapest possible demonstration of why the fixture
    // contains that sentence at all.
    const openers = markdown.split('\n').filter((l) => /^\s*```mermaid\s*\r?$/.test(l))
    expect(openers).toHaveLength(EXPECTED_FENCES.length)
    expect(markdown.match(/```mermaid/g) ?? []).toHaveLength(EXPECTED_FENCES.length + 1)
  })
})
