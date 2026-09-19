---
type: learning
title: terraform init 403 trên remote state — use_azuread_auth cần RBAC data plane, Owner không đủ
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: terraform/versions.tf
    commitSha: c358294b69f5ecf661e4ebaf1b0156c71414b010
createdAt: 2026-08-26
lastVerifiedAt: 2026-08-26
---

> Title kept in Vietnamese: knowledge frontmatter titles are immutable, and the
> slug is derived from it. Body translated to English 2026-09-03.

# `terraform init` 403 on remote state — `use_azuread_auth` needs data-plane RBAC; Owner is not enough

## Trigger

`terraform init` dies at the backend step with:

```
Failed to get existing workspaces: listing blobs: executing request:
unexpected status 403 ... AuthorizationPermissionMismatch
```

Applies to anyone cloning the repo for the first time and running
`terraform init`, and later to CI's service principal.

## Context

The Phase 1 state backend deliberately uses `use_azuread_auth = true` instead of
a storage access key — so there is no key to store, rotate, or accidentally
commit. See `terraform/versions.tf` and `docs/plan-phase1.md` §P1.

The account `vu.ngo@acme.com` is **Owner at subscription scope**, so
the first instinct is "highest privilege already, the 403 must be a misconfigured
backend". Wrong — the backend config is correct.

## Business rule

**Azure separates two permission planes on Storage, and Owner sits on only one
of them.**

| | Owner grants | Who can read a blob |
|---|---|---|
| Control plane (ARM) | create/delete/modify the storage account, read the access key | ❌ |
| Data plane (Blob) | — | only the `Storage Blob Data *` roles |

Owner lets you **delete the entire storage account** but not read a single blob.
This is not a bug, it is the design: a legitimate shortcut still exists — Owner
can read the access key and use that key to enter the data plane. That shortcut
is exactly what `use_azuread_auth = true` deliberately refuses, so the price is
one data-plane RBAC assignment.

## Resolution

Assign once per principal that needs to run Terraform (a person, and later CI's
SPN):

```bash
export AZURE_CONFIG_DIR="C:/dev/.azure-perso" MSYS_NO_PATHCONV=1
SUB=$(az account show --query id -o tsv | tr -d '\r')
OID=$(az ad signed-in-user show --query id -o tsv | tr -d '\r')
az role assignment create \
  --assignee-object-id "$OID" --assignee-principal-type User \
  --role "Storage Blob Data Contributor" \
  --scope "/subscriptions/$SUB/resourceGroups/rg-acme-tfstate/providers/Microsoft.Storage/storageAccounts/stacmetfstateprod01"
```

`MSYS_NO_PATHCONV=1` is mandatory — see
[[git-bash-path-conversion-pha-hong-az-scope]].

Verify with `terraform init` itself, not with `az role assignment list`: RBAC
takes 1–2 minutes to take effect, so the list can show the role before blob
access actually works.

**Do not "fix" this by dropping `use_azuread_auth` and going back to an access
key.** That trades a one-off RBAC assignment for a long-lived secret to manage
forever — precisely the class of problem recorded in
[[secret-baked-into-docker-image-via-appsettings]].

`Storage Blob Data Contributor` is the minimum that works: Terraform needs to
read, write **and** lease the state blob. `Storage Blob Data Reader` is not
enough.

## Sources

- Hit for real on the first `terraform init` for TASK-1724, 2026-08-26
- Backend block: `docs/plan-phase1.md` §P1 "Remote state"
