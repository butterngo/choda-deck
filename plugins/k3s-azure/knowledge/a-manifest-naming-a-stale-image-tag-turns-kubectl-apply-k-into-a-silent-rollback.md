---
type: learning
title: A manifest naming a stale image tag turns kubectl apply -k into a silent rollback that looks like a success
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: k8s/base/api-deployment.yaml
    commitSha: a0aaaa9cb8e42505f0f083bec6bc2ded7a42dab4
  - path: k8s/base/web-deployment.yaml
    commitSha: a0aaaa9cb8e42505f0f083bec6bc2ded7a42dab4
createdAt: 2026-09-12
lastVerifiedAt: 2026-09-12
---

**Trigger:** anyone runs `kubectl apply -k k8s/overlays/azure` after someone else has deployed by hand with `kubectl set image`.

**Context:** a hand deploy changes the live Deployment only. The manifest in git still names whatever tag it named before. `apply` reconciles the cluster *to the manifest*, so it dutifully sets the image back — and reports success, because from its point of view it did exactly what it was asked.

This was live in this repo for an afternoon: `acme-api` and `acme-web` ran `02980ee2` while `k8s/base/*-deployment.yaml` still read `c7532e1d` and `94bcf19d`. Any apply — including one intended to change something completely unrelated, such as an ingress host or a resource limit — would have rolled both services back to a build from two days earlier.

**Business rule:** a pinned image tag in a manifest is a declaration of what *must* run. Once the live state and the manifest disagree, the manifest wins at the next apply and the disagreement is resolved in the direction of whatever git last remembered. There is no warning, no diff shown by default, and nothing in the apply output names the images it changed.

**Why it is worse than an ordinary drift.** Most drift is visible as a failure: a missing Secret, a Pending PVC. This one is *silent and backwards* — the cluster gets quieter, not louder, and the deploy that gets undone was the correct one. The person who runs the apply is usually not the person who did the hand deploy, so nobody present has a reason to look at image tags.

**Resolution / discipline:**

1. **A hand deploy is not finished until the manifest is updated in the same change.** `kubectl set image` and the edit to `*-deployment.yaml` belong in one unit of work, exactly as a migration and its code do.
2. Before any `apply -k` on a cluster someone may have touched by hand, diff first:
   ```sh
   kubectl -n jm diff -k k8s/overlays/azure   # prints what apply WOULD change
   ```
   Read it for image lines specifically; that is the field most likely to be stale and least likely to be noticed.
3. When applying a fix to one workload, apply **that file**, not the whole overlay, if the rest of the overlay is known to be behind:
   ```sh
   kubectl -n jm apply -f k8s/base/chatengine-deployment.yaml
   ```

**The real fix is upstream of all three.** This trap exists because deploys are being done by hand at all. Once the Newacme pipeline (TASK-1730) is actually running, the tag reaching the cluster and the tag in git both come from the same commit and cannot diverge. Until then, treat every manual `set image` as a debt with a due date.

Closed for now by `a0aaaa9`, which pinned both manifests to `02980ee2` — the state that was actually running and verified by digest.
