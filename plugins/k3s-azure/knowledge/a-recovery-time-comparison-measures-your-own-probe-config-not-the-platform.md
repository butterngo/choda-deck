---
type: learning
title: A recovery-time comparison measures your own probe config, not the platform
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: docs/reports/qa-on-azure-vs-vps.md
    commitSha: a2a190a2c630e777e8c5134473dac9bbe41b82f5
createdAt: 2026-09-10
lastVerifiedAt: 2026-09-10
---

**Trigger:** you are comparing two hosting platforms and one recovers far faster than the other — a container back in 2 seconds against a pod back in 23. The number is real, reproducible, and looks like a verdict on the platforms.

**Context:** TASK-1919 compared the acme QA stack on Azure k3s against the same stack on the VPS. `kubectl delete pod` had the Azure pod serving again after 23s; `docker restart acme-web-qa` had the VPS container back in 2s. Presented bare, that reads as an order-of-magnitude platform gap.

**Business rule:** a measurement is only evidence about a platform if the platform, not your configuration, dominates it. Before reporting a difference as a property of the system, decompose the number and ask which part you chose.

**Resolution:** most of Azure's 23s was `initialDelaySeconds` of 10-15s on the readiness probes — a conservative first guess made while writing the manifests, not a measured value. The two figures also measure different things: Kubernetes reschedules a pod and waits for a probe to pass, Docker restarts a process. The report states this plainly and refuses to present the gap as a platform difference. Once real health endpoints exist (TASK-1723) the delays can be tightened and recovery should land far closer to the VPS's 2s.

The general shape: when your own configuration is the biggest term in a measurement, reporting it as a platform difference flatters nobody — it makes a conservative guess look like an infrastructure finding, and it survives into decisions long after the guess is forgotten. The companion habit is to decompose before comparing: the same report split TTFB into network (136ms Azure / 106ms VPS) and processing (62ms Azure / 94ms VPS), which showed Azure to be the faster machine and the VPS the closer one — a conclusion neither raw total supports on its own.

## Related

- Source: TASK-1919, SESSION-1788949482154-65
- `docs/reports/qa-on-azure-vs-vps.md`
- INBOX-1981 tracks tightening the delays after TASK-1723
