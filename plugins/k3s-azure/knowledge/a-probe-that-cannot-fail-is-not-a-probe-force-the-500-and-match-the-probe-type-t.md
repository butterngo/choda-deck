---
type: learning
title: A probe that cannot fail is not a probe — force the 500, and match the probe type to what the service can actually report
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: k8s/base/api-deployment.yaml
    commitSha: 8daab1a0f9229e54e12daa6e195022261497b5b3
  - path: k8s/base/web-deployment.yaml
    commitSha: 8daab1a0f9229e54e12daa6e195022261497b5b3
  - path: k8s/base/chatengine-deployment.yaml
    commitSha: 8daab1a0f9229e54e12daa6e195022261497b5b3
createdAt: 2026-09-12
lastVerifiedAt: 2026-09-12
---

## Trigger

You have added `readinessProbe` / `livenessProbe` to a Deployment, the pods report
`1/1 Running`, and you are about to call the work done.

## Business rule

A probe that is configured but has never returned non-200 is **indistinguishable
from a broken one** until something real breaks — which is the worst possible
moment to find out. Verifying a probe means forcing the endpoint to return 500 and
watching Kubernetes mark the pod NotReady and stop routing traffic to it.

That is the test TASK-1723 ran. A check that observes `1/1 Running` passes whether
the probe works or not, so it proves nothing about the probe.

## The probe type is a correctness decision, not a style choice

This cluster deliberately runs two kinds:

| Workload | Probe | Why |
|---|---|---|
| `chatengine` | HTTP `/health/ready` | It is the only service that exposes an endpoint reporting its **database** state |
| `acme-api`, `acme-web` | TCP | They expose no such endpoint, so anything richer would be a lie |

A TCP probe on a service that has lost its database keeps the socket open and
passes. So the choice decides whether a pod that can no longer do its job leaves
service or keeps receiving traffic. Record the compromise in the manifest when you
are forced into TCP, with the reason — otherwise the next reader upgrades it to
HTTP against an endpoint that does not exist, or leaves TCP in place long after a
real endpoint has shipped.

ChatEngine's **liveness** uses `/health`, not `/health/ready`, on purpose: a
database blip should stop traffic reaching the pod, not restart it. Restarting
fixes nothing and discards in-flight work.

## Caveat carried forward

`initialDelaySeconds` of 10–15s on this cluster was a conservative first guess, not
a measured value, and it accounts for most of the 23s pod recovery time. Now that
real health endpoints exist the delays can be tightened — see INBOX-1981. Do not
read that 23s as a platform characteristic; it is a configuration choice.

## Related

- [[a-recovery-time-comparison-measures-your-own-probe-config-not-the-platform]]
