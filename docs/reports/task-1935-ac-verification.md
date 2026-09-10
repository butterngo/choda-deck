# TASK-1935 — AC verification

**Adapter: PUT /workspace-docs — if-match, bytes, and an etag on the GET**
Session SESSION-1789045333112-42 · PR #288 · merged `b9013c9`
Verified 2026-09-10 by the `/choda-burn-backlog` runner (unattended).

**Result: 8 / 8 ticked. Merge proven. Task DONE.**

## Per criterion

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 no `if-match` → 400, file untouched | ✅ | 400 `if-match required`; sha256 identical before/after |
| AC-2 stale hash → 409, first writer's bytes survive | ✅ | second handle rewrites between read and save; 409 carries the **current** sha256. Control: fresh hash → 200 |
| AC-3 CRLF + BOM round-trips byte-identical | ✅ | read via `arrayBuffer` (not `Response.text`, which strips the BOM); `Buffer.compare === 0`; BOM still `EF BB BF`; CRLF still present |
| AC-4 traversal refused, outside file untouched | ✅ | `PUT /workspace-docs/main/../secret-outside.md` written raw over `net.connect` with a valid token **and a correct if-match for the outside file**; ≥400 and bytes unchanged |
| AC-5 saves never create | ✅ | 404 and `existsSync` false afterwards |
| AC-6 the cap is a limit, not a wall | ✅ | 2 MB+1 → 413, hash unchanged; 2 MB−1 → 200, file exactly 2,097,151 bytes |
| AC-7 reader and writer agree about binary | ✅ | GET 415 and PUT 415 on the same path; bytes unchanged |
| AC-8 the etag round-trips | ✅ | etag equals sha256 of the bytes on disk; passed straight back as `if-match` → 200 |

## Injections — both from the task's own Test Plan, both actually run

| injection | expected | observed |
|---|---|---|
| write made unconditional | AC-1 and AC-2 red, nothing else | exactly that — 2 failed, 11 passed |
| traversal guard removed | AC-4 red | AC-4 red, plus the pre-existing GET traversal tests |

The second one matters more than it looks. Without it, AC-4 could have been
passing because node normalised `../` out of the URL before the handler ever saw
it — a green test proving nothing about the guard. The injection is what
separates those two worlds.

## Findings

1. **The GET now ends with a Buffer rather than a decoded string, and that is
   the point.** Decoding on the server is the round trip that loses a BOM.
   `workspace-docs.test.ts`'s fake response decodes in the harness instead, so
   all 29 pre-existing assertions keep meaning what they meant — the harness
   moved, not the assertions.

2. **`sha256` / `readRawBody` / `writeAtomic` were extracted to
   `atomic-file.ts`, not copied.** Two routes now write a user's own file, and
   one promise — *the bytes go to disk exactly as they arrived* — should not have
   two implementations. They would agree today and drift the first time one is
   improved, which is precisely how a BOM gets lost. claude-config's 37 tests
   pass unchanged against the extraction.

3. **AC-4's fixture carries a correct `if-match` for the file it is trying to
   reach.** A traversal test that sends a wrong precondition can be refused by
   the 409 branch and never exercise the path guard at all.

## Gates

typecheck 0 · lint 0 · build 0 · full suite 2088 passed, 0 failed
(one documented worker-fork death, 157/158 files)
CI on PR #288: ubuntu, windows and docker-image all green.

## Not proven here

Nothing in this task is human-class, so nothing is carried forward. The route is
reachable only from a dev server until a release re-vendors the adapter bundle —
that is TASK-1938's job, and TASK-1937 is what will actually call it.
