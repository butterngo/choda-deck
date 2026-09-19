---
type: gotcha
title: Recreating a storage account under the same name leaves it healthy on the control plane and dead on the blob endpoint
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: terraform/storage.tf
    commitSha: 62c376f
createdAt: 2026-09-08
lastVerifiedAt: 2026-09-08
---

# Recreating a storage account under the same name leaves it healthy on the control plane and dead on the blob endpoint

## Trigger

A `terraform apply` was interrupted while creating `stacmebackupprod01`. The
account was tainted, so the next apply destroyed it and immediately created a new
one **under the same name**. Everything then looked fine and nothing worked.

```
az storage account show -n stacmebackupprod01 -g rg-acme-prod
  provisioningState : Succeeded          <- control plane says healthy
  allowSharedKeyAccess : False

az storage container list --account-name stacmebackupprod01 --auth-mode login
  ERROR: The specified resource does not exist.   <- data plane says it is not there
```

The caller held `Storage Blob Data Contributor` on that exact account, so this is
not a permissions problem. DNS resolved the name to a real storage stamp:

```
stacmebackupprod01.blob.core.windows.net -> blob.hkg21prdstr05a.store.core.windows.net
```

…which then answered `404` for every request. The name was mapped to a stamp
that does not serve it.

## Why it is worth knowing

Every diagnostic points somewhere else:

- Terraform reports it as **"waiting for the Data Plane ... to become
  available"** and polls for 20+ minutes, which reads like transient Azure
  slowness. It is not transient; it never becomes available.
- `terraform import` cannot rescue it either — the import fails while *reading*
  the account, on `retrieving static website properties ... 404`. So the usual
  "it exists but is not in state" recovery does not apply.
- The control plane keeps reporting `Succeeded`, so any check written against
  `provisioningState` passes.

## The fix

Abandon the name. Move to the next number and delete the broken account:

```hcl
# terraform/storage.tf
name = "st${var.prefix}backupprod02"   # 01 is burnt
```

`stacmebackupprod01` created cleanly in **1m23s**, against 20+ minutes of failed
polling on the reused name. That timing difference is the clearest signal that
the name, not the configuration, was the problem.

## How to avoid it

**Do not interrupt a `terraform apply`.** That is the root cause here — the kill
is what produced the tainted resource that led to the same-name recreate. A
storage account apply that looks stuck is usually a data-plane 403 (see
[[terraform-azuread-auth-needs-blob-data-role]] and the shared-key note), which
is fixed by granting a role **while the apply keeps running**.

If an account genuinely has to be rebuilt, either wait for the name to be fully
released by Azure, or move to the next number. Never delete and immediately
recreate in place.

Recorded in `/jm-terraform` §2b.
