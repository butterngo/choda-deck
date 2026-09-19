---
type: gotcha
title: A storage account with shared keys disabled needs storage_use_azuread, and the 403 surfaces as "waiting for the Data Plane"
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: terraform/versions.tf
    commitSha: 62c376f
  - path: terraform/storage.tf
    commitSha: 62c376f
createdAt: 2026-09-08
lastVerifiedAt: 2026-09-08
---

# A storage account with shared keys disabled needs `storage_use_azuread`, and the 403 surfaces as "waiting for the Data Plane"

## Trigger

`terraform/storage.tf` sets `shared_access_key_enabled = false` on purpose, so
that no leakable account key exists at all — the failure this project already
lived through (TASK-1722, credentials in git history).

Creating that account then fails:

```
Error: waiting for the Data Plane for Storage Account (...) to become available:
  waiting for the Blob Service to become available: polling failed:
  executing request: unexpected status 403
  (403 Key based authentication is not permitted on this storage account.)
  with KeyBasedAuthenticationNotPermitted
```

## Why it misleads

The headline is **"waiting for the Data Plane ... to become available"**, which
reads like Azure being slow or flaky — something to retry. The actual cause is in
the tail: the provider is authenticating with an account key, and the account is
refusing key auth exactly as configured. Terraform will poll this for 20+ minutes
before giving up.

The tempting "fix" is to set `shared_access_key_enabled = true`. That defeats the
entire reason the flag is there.

## The fix

Tell the provider to use Azure AD for data-plane calls:

```hcl
provider "azurerm" {
  features {}
  storage_use_azuread = true
}
```

This matches what the backend already does (`use_azuread_auth = true`), so the
two halves of the configuration finally agree.

## The second half: Owner is not enough

With `storage_use_azuread = true` the call is made as the signed-in principal —
and **subscription Owner does not grant data-plane access**. Creating the
container then fails the same way, this time on `AuthorizationPermissionMismatch`.
See [[terraform-azuread-auth-needs-blob-data-role]]; the same rule that applies to
the tfstate account applies to every account Terraform touches.

Grant at the **resource group**, so accounts created later (P5's databases, any
future storage) are covered without repeating this:

```powershell
az role assignment create --assignee <upn> `
  --role "Storage Blob Data Contributor" `
  --scope "/subscriptions/<sub>/resourceGroups/rg-acme-prod"
```

From Git Bash this needs `MSYS_NO_PATHCONV=1` — see
[[git-bash-path-conversion-pha-hong-az-scope]].

## A role granted mid-apply does not rescue that apply

Terraform mints its Azure AD token when the process starts, and role membership
is a claim inside the token. Granting the role while an apply is polling changes
nothing for that apply — it keeps retrying with the stale token until timeout.

Grant the role, then start a **new** apply. Do not wait, and above all do not
kill the running one: interrupting it is what burnt a storage account name
permanently ([[storage-account-name-burnt-by-same-name-recreate]]).

The same caching hits `az` afterwards, which keeps answering "you do not have the
required permissions" from a token minted before the grant. Reading blobs from
the node with its managed identity is often the faster check.

Recorded in `/jm-terraform` §2c.
