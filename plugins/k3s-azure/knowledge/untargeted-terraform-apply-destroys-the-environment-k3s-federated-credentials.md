---
type: learning
title: "An untargeted terraform apply destroys the two environment:k3s federated credentials CI depends on"
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: terraform/cicd.tf
    commitSha: cfdaccdebd1c7702f60d29f3da2fd4784730b561
  - path: terraform/variables.tf
    commitSha: cfdaccdebd1c7702f60d29f3da2fd4784730b561
createdAt: 2026-09-14
lastVerifiedAt: 2026-09-14
---

**Trigger:** `terraform plan` for any change in this repo — on 2026-09-14 it was a one-line NSG update for a rotated home IP — reports `Plan: 0 to add, 1 to change, 2 to destroy`, and the two destroys are:

```
azurerm_federated_identity_credential.github_actions["chatengine-env-k3s"]   (gh-chatengine-env-k3s)
azurerm_federated_identity_credential.github_actions["jm-env-k3s"]           (gh-jm-env-k3s)
  # (because key [...] is not in for_each map)
```

**Context:** both credentials carry a subject ending in `:environment:k3s`. `local.github_federated_subjects` in `terraform/cicd.tf` only generates `ref:refs/heads/<branch>` subjects from `var.github_cicd_repositories[*].refs`, so nothing in config produces them. They are in state, so they were created through Terraform at some point and the config that made them was later removed or rewritten without a matching state change.

**They are not dead.** `Newacme/.github/workflows/ci-be.yml` and `ci-fe.yml` deploy jobs run under `environment: k3s`; GitHub then presents an `environment:k3s` subject, and `gh-jm-env-k3s` is the record Entra matches it against. Destroy it and acme-api / acme-web CI fails at `azure/login` with AADSTS700213 on the next push (see `a-federated-credential-s-subject-is-what-github-sends-not-what-the-documentation`).

**Rule:** a destroy count you did not intend is a stop, not a detail. Until INBOX-2014 is resolved, every apply in this repo must be `-target`ed to the resource being changed:

```
terraform plan  -target=azurerm_network_security_group.node -out=nsg.tfplan
terraform show nsg.tfplan | grep '^Plan:'      # must read 0 to add, 1 to change, 0 to destroy
terraform apply nsg.tfplan
```

**Resolution (INBOX-2014, not done):** either add an `environments` list to `var.github_cicd_repositories` and generate `environment:<name>` subjects in `cicd.tf` so the two records are back under config, or `terraform state rm` them if they are meant to live outside Terraform. Pick one; the current state is the trap.

Source: `docs/reports/deploy-2026-09-14-k3s-chatengine-foundry.md`, "Side quest".
