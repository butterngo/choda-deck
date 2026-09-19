---
name: terraform
description: >
  Run Terraform against a client's Azure subscription without the failures this
  has already cost: an apply that silently targets the wrong account on a machine
  holding two, a plan whose destroy count nobody read, a managed identity whose
  principal_id cannot exist at plan time so the apply needs two passes, a storage
  account with shared keys disabled that stalls on what looks like an Azure fault
  but is the account refusing the credential, an interrupted apply that leaves a
  jammed lock and can burn a storage account name permanently, a deny policy that
  turns a clean plan into a failed apply, and a destroy whose plan undercounts
  because CSI-provisioned disks were never in state. Reads every plan for its
  destroy count, prices new billable resources against a hard monthly ceiling
  before applying, and refuses destroy without a typed confirmation. Trigger with
  "/k3s-azure:terraform", "terraform plan", "apply the terraform", "add this to
  Terraform", "what's in the state", or before any infrastructure change.
---

# Terraform against a client subscription

Assume this configuration manages something that is serving traffic. Every rule
below exists because skipping it cost real time or real money once.

## 0. The account, before any command

🔴 **A machine can hold more than one Azure login, and a bare `az` uses whichever
was authenticated last.** On such a machine, every `az` and `terraform` command
must carry the right config directory — the provider reads the same variable.

If `AZURE_CONFIG_DIR` is configured for this plugin, use it:

```bash
export AZURE_CONFIG_DIR="<the configured directory>"
az account show --query "{sub:name,id:id}" -o tsv
```

**Check the subscription name against the client's before doing anything else.**
An unexpected name means stop, not adjust — an apply into the wrong subscription
is not a mistake you notice from the output.

⚠️ **Git Bash rewrites any argument that looks like a POSIX path.** A
`--scope "/subscriptions/..."` becomes `C:/Program Files/Git/subscriptions/...`
and the error reads `MissingSubscription`, which sends people to re-login. Prefix
with `MSYS_NO_PATHCONV=1`, or run those commands from PowerShell.

⚠️ **A non-interactive shell has no stdin.** `terraform apply` waiting for `yes`
dies immediately with `error asking for approval: EOF`. Use `-auto-approve`, and
only after the plan has been read and reported.

## 1. Plan first, and read the plan for its destroy count

```bash
terraform plan -no-color -input=false
```

The line that decides everything:

```
Plan: 3 to add, 1 to change, 0 to destroy.
```

**Report that line to the user before applying, every time.** On a live cluster
the difference between `0 to destroy` and any other number is the difference
between a config change and an outage. A plan that destroys anything must be
surfaced with the resources named and confirmed explicitly — never folded into
"applying now".

🔴 **Watch for changes that force replacement rather than update.** On a
single-node cluster the dangerous one is the VM's `custom_data` / cloud-init:
editing it **replaces the VM**, and the replacement boots a fresh k3s with an
empty etcd. Every manifest, Secret and ConfigMap the cluster held lives in that
etcd. A one-character change to a bootstrap template can therefore destroy the
whole cluster state while the plan says `1 to change`.

## 2. A new managed identity needs two applies

Adding `identity { type = "SystemAssigned" }` to a VM that lacks one makes any
role assignment referencing its `principal_id` fail **at plan time**:

```
Error: Missing required argument
  The argument "principal_id" is required, but no definition was found.
```

This is not a broken configuration. The identity does not exist in state yet, so
`identity[0]` is out of range and resolves to null — Terraform cannot plan a value
that will only exist after the apply.

```bash
terraform apply -target=<the vm> -target=<what the role assignments scope to>
terraform apply
```

Adding the identity is an **in-place** change, not a replacement. Confirm the plan
says so before running it.

## 3. Never interrupt a running apply

Interrupting leaves three problems, and the third has no clean fix.

1. **The state lock survives.** The next apply refuses with
   `state blob is already locked`. Recoverable with `terraform force-unlock -force <ID>`
   — but only once you have confirmed no apply is genuinely still running elsewhere.
   The lock exists to stop two writers, not to annoy you.

2. **Resources created just before the kill are orphaned.** They exist in Azure but
   not in state, so the next apply tries to create them again and fails with
   `already exists - to be managed via Terraform this resource needs to be imported`.
   Usually recoverable with `terraform import`.

3. 🔴 **A storage account destroyed and recreated under the same name can come back
   permanently broken.** The recreated account reports `provisioningState: Succeeded`
   on the control plane while its blob endpoint answers `404 ResourceNotFound` to a
   caller *holding* Storage Blob Data Contributor. DNS resolves the name to a stamp
   that does not serve it. `terraform import` cannot even read it. The only fix
   observed was to abandon the name entirely and move to the next one.

**So: if an apply looks stuck, read why before reaching for Ctrl-C.** A storage
account sitting at "Still creating…" for twenty minutes is usually the data plane
being refused (§4), which is fixed by granting a role **with the apply left running**.

## 4. Storage accounts with shared keys disabled

Disabling `shared_access_key_enabled` means no leakable key exists — worth doing,
with two consequences that do not announce themselves.

**The provider must be told to use Azure AD.** Its default probes the Blob service
with key auth, which the account rejects:

```
403 KeyBasedAuthenticationNotPermitted
```

Terraform surfaces this as *"waiting for the Data Plane to become available"*,
which reads like a transient Azure fault rather than a deliberate refusal. Set
`storage_use_azuread = true` in the provider. **Never re-enable shared keys to make
an apply pass.**

**Subscription Owner is NOT enough to create a container.** Container creation is a
*data-plane* call; Owner and Contributor are control-plane roles. Without a
data-plane role the apply hangs the same way, on `AuthorizationPermissionMismatch`.
Grant it at the **resource group** so accounts created later are covered too:

```bash
MSYS_NO_PATHCONV=1 az role assignment create --assignee <upn> \
  --role "Storage Blob Data Contributor" \
  --scope "/subscriptions/<sub>/resourceGroups/$RESOURCE_GROUP"
```

🔴 **A role granted mid-apply does not rescue the running apply.** Terraform takes
its Azure AD token when the process starts, and role membership is a claim inside
that token. The apply keeps polling with the old token until it times out. Grant
the role, then start a **new** apply — do not sit and wait. The same cached-token
trap hits `az` afterwards, so re-login before concluding the role did not work.

## 5. A clean plan can still fail at apply

Deny policies exist because a budget alert only sends email — Azure cannot stop
spend on pay-as-you-go. A plan is computed locally and knows nothing about them, so
a perfectly clean plan can die with `RequestDisallowedByPolicy`.

Typically denied: VM SKUs outside an allowlist, regions outside an allowlist, and
resource types that can run up a bill fast.

🔴 **`RequestDisallowedByPolicy` means the guardrail worked.** Do **not** widen the
policy to make the apply pass. Removing an entry is a recorded decision and a cost
conversation, which is the entire reason it is there.

## 6. The cost ceiling is hard

If `MONTHLY_CEILING_USD` is configured, treat it as a refusal threshold, not a
target.

**Before applying anything billable, state what it adds and what headroom remains.**
If it does not fit, the answer is to re-quote — never to raise the budget variable
so the number works.

Price from the **Azure Retail Prices API**: it needs no auth, has no rate limit,
and returns list prices for the client's own region. Do not price from memory;
rates differ by region and change.

```bash
curl -s "https://prices.azure.com/api/retail/prices?\$filter=armRegionName eq '<region>' and serviceName eq 'Virtual Machines'" | head -c 2000
```

For **actually billed** spend rather than list price, Cost Management is the
authority — but it rate-limits hard, and a 429 there is not a broken command.
Back off in minutes, not seconds.

⚠️ **Say which uptime you mean.** On a small cluster, disks and the static IP bill
continuously while the VM is the only elastic line. "The cluster costs X" and "the
cluster costs X/5" can both be true and differ by several times over. Quote a range
for continuous running, since Azure's accounting month is 730 h while real months
are 720 or 744.

## 7. `terraform destroy` — never without a typed confirmation

Require the user to type the word `destroy` in their own message. An earlier
"go ahead" on an apply is **not** authorisation to destroy.

Destroying takes the cluster, its etcd, and every workload. A static IP is
recreated with a **different address**, so every DNS record pointing at the old one
breaks.

### 🔴 The plan does not list everything destroy will delete

Read this out **before** any destroy, because the plan will not.

Volumes created by a CSI driver are **not in Terraform state** — Terraform never
made them, so it cannot name them. But they live in the resource group, and
destroying the group takes them with it. A plan reporting `N to destroy` is
therefore an undercount, and the missing entries are the stateful ones.

Enumerate them for this cluster before confirming:

```bash
kubectl --context "$KUBE_CONTEXT" get pv \
  -o custom-columns=NAME:.metadata.name,CLAIM:.spec.claimRef.name,SIZE:.spec.capacity.storage
```

For each, say what it holds and what losing it costs. An etcd snapshot does **not**
cover them: it holds the PVC *objects*, not the disks behind them, so restoring
from a snapshot brings back resources that bind to nothing.

State `0 to destroy` out loud even when CSI volumes are nonetheless at risk — that
line is exactly what a reader will trust.

## 8. After an apply that touched the cluster

Power state is not health. Verify the cluster actually came back:

```bash
kubectl --context "$KUBE_CONTEXT" get nodes
ssh <node> 'sudo k3s etcd-snapshot ls | tail -2'
```

🔴 **`etcd-snapshot ls` is the load-bearing check.** It fails outright on a
SQLite-backed install, so it distinguishes "the cluster came back" from "*a*
cluster came back". If the VM was replaced, the snapshot history will be empty —
that is the signal that etcd is new and the previous cluster state is gone.

## 9. Cost hygiene while building

A cluster under construction does not need to run overnight.

```bash
az vm deallocate -g "$RESOURCE_GROUP" -n <vm>
az vm start -g "$RESOURCE_GROUP" -n <vm>
```

⚠️ **Deallocate, never `az vm stop`.** The latter shuts the OS down while keeping
the compute reserved — and billed.

## Rules

- **Never run `terraform` or `az` without confirming the subscription first** on a
  machine that holds more than one account.
- **Always plan before apply, and report the `N to destroy` count** before running it.
- **Never `terraform destroy`** without the user typing `destroy`.
- **Never interrupt a running apply.** A stuck-looking apply is usually a data-plane
  403, fixed by granting a role while it runs.
- **Never re-enable shared keys, widen a deny policy, or raise the budget variable**
  to make an apply succeed. All three are guardrails whose value is in refusing.
- **Never write a subscription id, tenant id or secret into a `.tf` file** or into
  documentation. Keep them in a gitignored location and reference them by path.
- **After a change that could replace the VM, verify etcd survived** rather than
  assuming it did.
