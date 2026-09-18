---
type: learning
title: "Two rules for a resumable chunked upload: append before the marker, and refuse gaps"
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/meetings.ts
    commitSha: 6c5a466fe9b458b4b31dfefb5735e988af1347d7
  - path: src/adapters/companion/meetings.test.ts
    commitSha: 6c5a466fe9b458b4b31dfefb5735e988af1347d7
createdAt: 2026-09-16
lastVerifiedAt: 2026-09-16
---

**Trigger:** you are writing a route that accepts a stream in pieces — an upload, a
log shipper, an append-only sink — and you need two things from it: knowing where to
resume after a crash, and refusing a piece that would corrupt the file.

Both have an obvious implementation that is wrong in a way tests rarely catch.

## Rule A — append the bytes, THEN persist the sequence marker

Two writes per chunk: the data, and the record of how far you have got. Their order
is the durability contract, and a crash between them is the only case that matters.

- **Marker first:** the marker says chunk N landed; the crash means it did not. The
  client resumes at N+1 and the audio, the log line, the upload has a hole in it. The
  loss is silent and permanent.
- **Bytes first** (what `meetings.ts` does): the crash leaves the bytes written and
  the marker stale, so the server re-offers sequence N and accepts the client's
  retry. Worst case one chunk is written twice.

Choose the second. **Duplicating a request is recoverable; losing data is not.** The
comment at the write site should say so, because the order looks arbitrary and the
next person will helpfully "fix" it.

## Rule B — refuse a GAP, not only a repeat

Most implementations check for a repeated sequence, because a repeat obviously
double-appends. The gap is the dangerous one and is easy to leave out.

A repeat produces a file that is visibly too long. A **gap** produces a file that is
merely missing a slice in the middle — and for most container formats it still opens,
still reports a duration, still plays. The corruption does not announce itself; you
find it months later in the one recording that mattered.

So validate against exactly `last + 1` and answer 409 for anything else, both
directions. `meetings.ts` returns the expected number in the error body so the client
can resynchronise rather than guess:

```
if (seq !== last + 1) → 409 { error: `expected seq ${last+1}, got ${seq}`, expected: last+1 }
```

**Check before touching the file**, not after. A handler that appends and then
notices is a handler whose 409 is a lie.

## Testing it

The gap case needs its own test — a suite that only covers the repeat passes while
the worse bug ships. `meetings.test.ts` has both, and each asserts the file's byte
length is unchanged afterwards, because the status code alone does not prove the
handler kept its hands off.
