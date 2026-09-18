---
type: learning
title: A packaged install's dataDir is not your CHODA_DATA_DIR — anything resolved relative to it breaks only after install
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/meeting-transcribe.ts
    commitSha: 
  - path: src/adapters/companion/service-factory.ts
    commitSha: 
createdAt: 2026-09-18
lastVerifiedAt: 2026-09-18
---

**Trigger:** a route works in dev and in every test, and the INSTALLED companion answers 501 / "not configured" for the same request. Anything whose location is derived from the data dir is suspect.

**Context.** `resolveDataDir` (companion `electron/adapter-launcher.cjs`) returns `CHODA_DATA_DIR` when set, else `<userData>/data` for a packaged app. Butter's shells have `CHODA_DATA_DIR=C:\dev\choda-deck\data`, so dev, tests and any adapter started from a terminal read that tree. The installed app did NOT inherit it and used `%APPDATA%\choda-deck-companion\data` — the same app, a different tree, with its own `artifacts/`, `ai-key.txt` and recordings.

TASK-1991 resolved the Azure Speech key as `<dataDir>/../sensitive_information/azure-speech.txt`. In dev that is the repo's own gitignored folder and works. In the install it becomes `%APPDATA%\choda-deck-companion\sensitive_information\azure-speech.txt`, which does not exist, so `POST /meetings/:id/transcribe` answered 501 "speech not configured" on 2026-09-18, minutes before a client meeting. Every test passed, because every test set the env var.

**Business rule.** A file the adapter must find after installation is located by an explicit env var (`CHODA_SPEECH_CREDENTIALS_FILE`, `CHODA_VAULT_DIR`) or by a path that exists in an installed profile. `<dataDir>/../something` is a dev-only convention: it silently relocates with the data dir and the relocation is invisible until someone installs the build.

**Resolution / how to check.**
1. Which tree is the installed app actually using? Compare `companion-port.txt` and `artifacts/meetings/` under `%APPDATA%\<app>\data` and under `CHODA_DATA_DIR`. The one holding the newest recording is the live one.
2. Fix forward: set the explicit env var, or ship the file into the installed profile. The 2026-09-18 stopgap copied `azure-speech.txt` into `%APPDATA%\choda-deck-companion\sensitive_information\`, which unblocks the route at once (credentials are read per request, no restart) at the cost of a second copy of a secret.
3. The same question applies to every other such path — `CHODA_VAULT_DIR` for the meeting-note save route is the next one to verify in an install, not in dev.

**Related:** `verify-a-vendored-bundle-at-the-packaged-path-not-the-staging-directory` (same family: the install disagrees with the checkout), `registered-to-auto-start-is-not-serving-prove-which-path-owns-the-port`.
