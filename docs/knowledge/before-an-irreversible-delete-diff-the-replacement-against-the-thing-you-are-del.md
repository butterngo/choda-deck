---
type: learning
title: Before an irreversible delete, diff the replacement against the thing you are deleting
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-09-19
lastVerifiedAt: 2026-09-19
---

**Trigger:** you are about to `rm` a file or folder because a corrected version exists, and you can name the corrected version. The delete feels safe *because* you made the replacement yourself.

**Context.** TASK-2011 ended with a note in the vault whose ▶ stamps were two minutes wrong. The transcript was repaired, the note was re-drafted and saved as `2026-09-17-chi-kate-v3/`, and Butter approved deleting the superseded `2026-09-17-kata/`.

Listing the old folder first showed this:

```
2026-09-17-kata/        note.md   transcript.md
2026-09-17-chi-kate-v3/ note.md
```

The old folder carried **two** files. The replacement carried one. `rm -rf` at that moment would have taken the vault's only transcript copy for that meeting — while executing an instruction that was, on its face, correct.

Nothing in the reasoning would have caught it. The replacement was built deliberately, the deletion was approved deliberately, and the gap was a file nobody had mentioned in the entire discussion. It was caught by `ls`.

**Business rule.** "I created the replacement" is not knowledge of what the replacement *contains*. The set of things you deliberately produced and the set of things the original held are different sets, and only the second one matters when the original is about to stop existing.

This is sharper for generated artefacts than for hand-written ones. A route that writes `[{name: 'note.md'}]` writes exactly that; a folder accumulated over days holds whatever anyone ever saved into it. The asymmetry is invisible from the code that produced the replacement.

**Resolution.** List both sides and compare names before the delete — not sizes, not "looks right", the actual entries. If the replacement is missing something, produce it first and re-verify, then delete.

Here that meant rendering the corrected `transcript.md` from the repaired `transcript.json` and saving it to v3, confirming 257 lines with the phrase stamped `[00:14:51]`, and only then removing the old folder.

Related and separate: the *corrupt* artefact itself was preserved in `docs/reports/` rather than deleted, because it could not be reproduced on demand. Deleting evidence and deleting a superseded copy are different decisions — see `check-derived-timings-against-physics-before-persisting-them`.
