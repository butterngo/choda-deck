---
type: learning
title: A federated credential's subject is what GitHub sends, not what the documentation describes
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: terraform/cicd.tf
    commitSha: 965f3b0f11c8243f440b50262ba448012c80b8f0
  - path: terraform/variables.tf
    commitSha: 965f3b0f11c8243f440b50262ba448012c80b8f0
createdAt: 2026-09-10
lastVerifiedAt: 2026-09-10
---

## Trigger

`azure/login` fails on the **first CI run** with:

```
AADSTS700213: No matching federated identity record found for presented assertion
subject 'repo:owner@308612277/name@1314822903:ref:refs/heads/main'
```

The Terraform applied cleanly minutes earlier. The message names a credential problem, so the instinct is to re-check the identity, the role assignments, or the `id-token: write` permission. All of those are fine.

## What is actually happening

The federated credential was built from the documented shape:

```hcl
subject = "repo:${owner}/${name}:ref:refs/heads/${ref}"
```

GitHub does not send that. This organisation's default subject carries the **numeric organisation and repository ids**:

```
repo:owner@<orgid>/name@<repoid>:ref:refs/heads/main
```

That is the rename-proof form, and it is a better design than the one in most tutorials: renaming or transferring a repository no longer hands the old name's trust to whoever claims that name next. It is not a misconfiguration to be undone — `use_default` reads `true`, and the prefix is simply what the default now is for this org.

## Why this class of error cannot be caught earlier

Terraform has no way to know what GitHub will present. Both credentials applied without a warning, both read back correctly in state, and `terraform plan` was clean. The mismatch is only observable when a token is actually minted and offered — which is the first CI run, typically after a merge, in front of whoever is watching.

So the usual defence (read the plan carefully) does not apply here at all. The defence has to be **reading the value from the source instead of assembling it**.

## Resolution

Read the prefix from GitHub and store it verbatim:

```bash
gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix
```

`terraform/variables.tf` now carries `subject_prefix` per repository, with a validation that rejects anything not beginning with `repo:` — because guessing this costs a failed CI run rather than a failed apply, the validation is cheap insurance in the wrong direction being the only insurance available.

`terraform/cicd.tf` appends only the ref:

```hcl
subject = "${repo.subject_prefix}:ref:refs/heads/${ref}"
```

## Still waiting to bite

`acme-api` / `acme-web` (Newacme) have a federated credential and an ACR purge filter but **no workflow yet**. Their prefix is already recorded, so the trap is disarmed there — but the same reasoning applies to any repository added later: fetch the prefix, never assemble it.

## Related

- One half of a pair with [[a-github-runners-identity-lives-in-its-install-directory-so-the-volume-must-hold-the-whole-install]] — both were faults that a clean apply and a green plan could not reveal.
- TASK-1730 (P7a), commit `0a5e720`, PR juvenis-maxime-ops#9.
