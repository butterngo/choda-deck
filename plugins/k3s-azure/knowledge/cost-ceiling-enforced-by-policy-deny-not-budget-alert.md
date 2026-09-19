---
type: learning
title: A budget alert cannot stop spending — the 170 USD ceiling is enforced by Azure Policy deny
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: terraform/policy.tf
    commitSha: 6944a19d49e94a37072b3ff9c8ace8b8f71708b9
  - path: terraform/budget.tf
    commitSha: 6944a19d49e94a37072b3ff9c8ace8b8f71708b9
createdAt: 2026-09-02
lastVerifiedAt: 2026-09-02
---

## Trigger

You need a hard cost ceiling on a Pay-As-You-Go subscription and reach for an
Azure budget, assuming it will stop spending when the threshold is crossed.

## Context

Ceilings agreed 2026-08-26: **170 USD/month infrastructure**, 130 USD/month AI.
Measured infrastructure cost is 117.05 USD/month (D2s_v5 96.36 + P6 11.23 +
P4 5.81 + public IP 3.65), leaving ~31% headroom.

## Business rule

**An Azure budget only sends email. It cannot stop spending on
Pay-As-You-Go.** Treating a budget as enforcement leaves the ceiling
unenforced while looking enforced on a dashboard.

## Resolution

Enforcement is four **Azure Policy deny** assignments: allowed VM SKUs,
allowed region, allowed region for resource groups, and denied (expensive)
resource types. The budget stays, but only as notification — three thresholds
at 80% actual, 100% actual, 100% forecast.

### The rejected alternative, and why

An automation runbook that deallocates the VM when spend crosses the
threshold was considered and rejected: spend crosses the threshold **at the
end of the month**, which is exactly when traffic peaks. That design takes the
website down at the worst possible moment. Blocking *creation* of new
resources degrades nothing that is already serving users.

### Known consequence, accepted deliberately

The policies also block **us**. Upgrading the VM SKU, or standing up the
MySQL/PostgreSQL flexible servers in P5, will be denied until
`var.allowed_vm_skus` / `var.denied_resource_types` are amended. That friction
is intended — but it will surprise anyone who does not know it is there.

### Two gaps the enforcement does not cover

- **Egress bandwidth.** Not in the 117 USD figure and invisible to Azure
  Policy: first 100 GB free, then ~0.12 USD/GB. It is the only line item that
  grows with user count.
- **The 130 USD AI ceiling has no alert at all.** Gemini and ChatEngine bill
  outside Azure, so neither budget alerts nor Azure Policy reach them. A
  separate alert on the Google Cloud side is still missing.

> Related trap from the same work: the budget was first created with the wrong
> currency (4,500,000 — read by Azure as USD, not VND), producing a 4.5-million-
> dollar ceiling whose alerts would never fire. That broken state **passed** its
> acceptance criterion once. Azure always bills a budget in the subscription's
> billing currency.
