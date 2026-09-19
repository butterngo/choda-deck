---
type: learning
title: A branch cut before the probe endpoint landed hangs the rollout forever, and the app logs look perfect
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: k8s/base/api-deployment.yaml
    commitSha: a0aaaa9cb8e42505f0f083bec6bc2ded7a42dab4
createdAt: 2026-09-12
lastVerifiedAt: 2026-09-12
---

**Trigger:** `kubectl rollout status` times out. The new pod is `Running` with `restartCount 0` but never becomes `Ready`. Its application log shows a clean startup — database connected, Hangfire up, no exception anywhere.

**Context:** deploying an image built from a feature branch that was cut **before** the commit which added the endpoint the probe calls. Here: `readinessProbe` hits `/health/ready`, which arrived in `c7532e1d` (TASK-1723). `feat/chat-engine-integration` branched earlier, so `14262f3a` has no such route — the probe gets a 404 forever, and a 404 is not ready.

**Business rule:** a probe path is a contract between the manifest and the image. Deploying any image whose lineage predates the probe endpoint breaks that contract, and the break is invisible in the application's own logs because from the app's point of view nothing is wrong — it is answering 404 to a request for a route it does not have, exactly as it should.

**Check ancestry before building, not after the rollout stalls:**

```sh
git merge-base --is-ancestor c7532e1d <commit-to-deploy> \
  && echo "has /health/ready" || echo "NO readiness endpoint — rollout will hang"
```

**The good news, worth noticing.** The rollout hanging is the system working. `maxUnavailable` kept the old pod serving the whole time; the site stayed 200 throughout and `kubectl rollout undo` returned cleanly with the original pod never restarted. This is the property TASK-1723 was about: a probe that can actually fail stops a bad build from taking traffic. Had the probe pointed at `/health` — which every build has and which cannot fail while the process is up — the broken image would have gone live and looked healthy.

**The same lineage gap silently disarms the keyring.** `939d284e` is what makes the app call `AddDataProtection()` with `DataProtection__KeyPath`. Without it the env var and the mounted PVC are both still there and both ignored: the pod starts fine, writes keys to the container filesystem, and every outstanding password-reset link dies at the next restart. Nothing fails, which is why loosening the probe to "make the deploy work" is the wrong move — it would have shipped that silently.

**Resolution — cherry-pick, not merge.** The two commits (`939d284e`, `c7532e1d`) cherry-picked cleanly onto the branch; the result is `02980ee2`, which rolled out with `/health` and `/health/ready` both 200 and the keyring file on the PVC unchanged (same key id, same mtime — proving the new build read the persisted key rather than generating a new one).

Merging all of `master` was rejected and the reason matters: it conflicted across **12 files and ~740 lines**, including `ProjectMissionGateService.*`, `GeminiEvaluatorProvider` and 303 lines of the admin project page. JM_FE has no unit tests and CI deliberately does not lint or build it (a stated coverage gap), so a wrong conflict resolution there would be caught by nothing. Cherry-picking the two commits the cluster actually requires keeps the blast radius to what was verified; the rest of `master` reaches the branch later through a normal PR with review.

**Rule of thumb:** when a deploy needs commits from another branch, take the *smallest set the environment requires*, not the whole branch. "Merge master" is the reflex; it is the right answer only when someone is prepared to review the conflicts it produces.
