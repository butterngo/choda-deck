---
type: gotcha
title: A docker verb that streams needs the connection — over a TCP DOCKER_HOST it returns nothing and exits 0
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/docker-engine.ts
    commitSha: 1af24ace7b30b8c1e20dc8990840f59c9fce41dd
  - path: src/adapters/companion/docker-exec.ts
    commitSha: 1af24ace7b30b8c1e20dc8990840f59c9fce41dd
createdAt: 2026-09-07
lastVerifiedAt: 2026-09-07
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** an adapter route shells out to `docker exec` and the pane it feeds comes back empty — not an error, not a timeout, just nothing. The route's own tests are green, the parse is correct, and the container is running.

**Context:** TASK-1875 built the Files pane on `docker exec <id> ls -la <path>` through the CLI. It answered `200 {"entries":[]}` for every path in every container from the day it shipped until 2026-09-07. Measured on this machine:

```
docker exec <id> ls -la /   -> no output, exit 0
docker exec <id> echo hi    -> no output, exit 0   (also -i, also -t, also redirected to a file: 0 bytes)
docker logs --tail 2 <id>   -> normal output
```

The environment carries `DOCKER_HOST=tcp://localhost:2375`. `docker exec` has to **hijack** the connection to stream stdout back to the client, and over that endpoint the hijack yields nothing while the process still exits 0. `docker logs`, `docker ps` and `docker images` are ordinary request/response calls, so they were unaffected — which is why every other docker feature in the companion worked and only this one did not.

**Business rule:** a subprocess that returns no output and exit 0 has told you two things that are indistinguishable from each other: "the command printed nothing" and "the transport lost what it printed". If a route depends on the difference, it must not read them off one channel. Use the docker **engine HTTP API** — `POST /containers/<id>/exec`, `POST /exec/<id>/start`, `GET /exec/<id>/json` — where the output arrives on the stream and the exit code arrives from a separate call.

**Resolution:** `docker-engine.ts` resolves the endpoint the way the CLI does (`DOCKER_HOST`, else the platform socket / named pipe), demuxes the 8-byte frame headers so stdout is not interleaved with stderr, and returns `{ stdout, stderr, exitCode }` as three separate facts. `docker-exec.ts` consumes that; an unreachable daemon is its own 502 with the reason named, never an empty list.

Two things this does NOT change, and both are load-bearing:

* The path still cannot become a flag — see [[a-path-in-argv-needs-no-shell-escaping-it-needs-a-dash-check]], whose dash check survives the rewrite untouched.
* The command is still one of two fixed programs. It is now *stronger* by construction: the argv carries no `exec` verb and no container id, because the engine binds the command to the container itself.

**Untested ground:** the client speaks plain HTTP and does not handle a TLS-protected `DOCKER_HOST` (`DOCKER_TLS_VERIFY`). Nobody here has that configuration; it would surface as a stated 502, not a silent empty list.

Fixed in TASK-1894 (#280, `1af24ac`), shipped in companion 0.12.2.
