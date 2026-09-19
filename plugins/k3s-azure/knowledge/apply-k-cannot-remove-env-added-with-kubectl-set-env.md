---
type: learning
title: kubectl apply -k cannot remove env vars that were added with kubectl set env
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: k8s/base/chatengine-deployment.yaml
    commitSha: cfdaccdebd1c7702f60d29f3da2fd4784730b561
createdAt: 2026-09-14
lastVerifiedAt: 2026-09-14
---

**Trigger:** you delete an `env:` block from a Deployment manifest in `k8s/base`, run `kubectl diff -k k8s/overlays/azure`, and it prints nothing for that Deployment. `kubectl apply -k` then changes nothing either. The live pod keeps every variable you just removed.

**Context:** on 2026-09-14 (TASK-1959) the 20 `Llm__Roles__*` overrides on the `chatengine` Deployment were in the manifest *and* on the cluster, but the cluster's `kubectl.kubernetes.io/last-applied-configuration` annotation contained none of them. `managedFields` listed `kubectl-set` as a manager: the block had been put on the live object with `kubectl set env` on 2026-09-12, and only afterwards copied into the repo. It never went through `kubectl apply`.

**Rule:** client-side apply is a three-way merge between last-applied, the new manifest and the live object. A field is pruned only if it is in last-applied and absent from the new manifest. A field that reached the cluster through `kubectl set env`, `kubectl set image`, `kubectl edit` or `kubectl patch` is not in last-applied, so apply never removes it — and `diff` reports nothing because it runs the same merge. The repo and the cluster can disagree forever while every apply says "unchanged".

**Resolution:** remove the field on the live object once, then the repo is the truth again:

```
kubectl -n jm patch deploy chatengine --type=json \
  -p '[{"op":"remove","path":"/spec/template/spec/containers/0/env"}]'
```

Guard before the patch: confirm the container index and that the env list contains only what you mean to drop. After the patch, `kubectl diff -k` against the repo was clean.

**How to tell you are in this situation:** compare the count of the field on the live object against the count in the annotation —

```
kubectl -n jm get deploy chatengine -o jsonpath='{.spec.template.spec.containers[0].env[*].name}' | wc -w
kubectl -n jm get deploy chatengine -o jsonpath='{.metadata.annotations.kubectl\.kubernetes\.io/last-applied-configuration}' | grep -o Llm__ | wc -l
```

Live 20, annotation 0 is the signature. Sibling of the stale-tag note (`a-manifest-naming-a-stale-image-tag-turns-kubectl-apply-k-into-a-silent-rollback`): that one is the repo lagging the cluster on a field apply *does* own; this one is a field apply does not own at all.

Source: `docs/reports/deploy-2026-09-14-k3s-chatengine-foundry.md`, addendum.
