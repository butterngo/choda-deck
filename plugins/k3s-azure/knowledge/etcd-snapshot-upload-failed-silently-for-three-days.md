---
type: learning
title: The etcd snapshot upload failed every scheduled run for three days while the timer reported enabled and on schedule
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: scripts/jm-etcd-snapshot-upload.sh
    commitSha: 62c376f
  - path: terraform/identity.tf
    commitSha: 62c376f
createdAt: 2026-09-08
lastVerifiedAt: 2026-09-08
---

# The etcd snapshot upload failed every scheduled run for three days while the timer reported enabled and on schedule

## What happened

Between 2026-09-04 and 2026-09-07 the cluster had **no off-machine backup at
all**, and every surface check said otherwise:

```
systemctl is-enabled jm-etcd-snapshot-upload.timer   -> enabled
systemctl list-timers jm-etcd-snapshot-upload.timer  -> firing hourly, on schedule
k3s etcd-snapshot ls                                 -> five snapshots, growing
```

Only the unit's own journal told the truth:

```
[jm-snapshot-upload] no managed-identity token:
  {"error":"invalid_request","error_description":"Identity not found"}
```

k3s kept writing snapshots to `/var/lib/rancher` on the node's own data disk, and
nothing ever left the machine. **A snapshot that only exists on the disk it
protects is not a backup.** With embedded etcd, that disk holds every manifest,
Secret and ConfigMap in the cluster.

## Why nothing caught it

Every cheap check was answering a different question than the one that mattered:

| Check | What it actually proves |
|---|---|
| timer `enabled` | systemd will *try* |
| `list-timers` shows recent runs | the unit *started* |
| `etcd-snapshot ls` non-empty | k3s is snapshotting **locally** |
| **journal shows `uploaded ...`** | a file **reached Blob** |

Only the last one is the backup working. The first three all passed throughout.

## Root cause

Three independent gaps, each sufficient on its own:

1. `terraform/identity.tf` and `storage.tf` were written but **never applied** —
   the VM had no system-assigned identity, so IMDS answered `Identity not found`,
   and the storage account did not exist either. The code was ahead of the state.
2. The provider needed `storage_use_azuread`
   ([[shared-key-disabled-needs-storage-use-azuread]]).
3. An interrupted apply burnt the account name
   ([[storage-account-name-burnt-by-same-name-recreate]]), so the uploader also
   had to be repointed at `stacmebackupprod01`.

## How to check it properly

Read the outcome, not the schedule:

```bash
ssh ... 'journalctl -u jm-etcd-snapshot-upload -n 20 --no-pager'
```

To list the container, ask the **node** — it holds the managed identity, while
`az` on a workstation may serve a token minted before the role grant:

```bash
tok=$(curl -s -H Metadata:true \
  "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
curl -s -H "Authorization: Bearer $tok" -H "x-ms-version: 2021-08-06" \
  "https://stacmebackupprod01.blob.core.windows.net/etcd-snapshots?restype=container&comp=list"
```

## Do not trigger the unit by hand to prove it works

`systemctl start jm-etcd-snapshot-upload` proves the *command* runs. It does not
prove the *schedule* does — and it overwrites the one thing that distinguishes
them, because the blob's `Last-Modified` then carries the moment a human typed
the command.

That mistake was made here: five blobs were uploaded manually at 12:55, after
which every scheduled run reported `0 uploaded, 5 already present` and proved
nothing. The evidence had to be reacquired by waiting for k3s's own 00:00 UTC
snapshot, which the hourly timer then uploaded at `00:00:37` — a timestamp
traceable to a timer firing in the journal rather than to a person.

k3s snapshots at 00:00 and 12:00 UTC; the uploader runs hourly. A genuine
scheduled upload is therefore at most an hour away. Wait for it.

## Still open

Backups now leave the machine, but **no restore has ever been tested**. Restoring
from an etcd snapshot is untried, and an untested backup is a hypothesis. This is
already listed under "what this cluster is not, yet" in `/jm-k3s`.

Recorded in `/jm-k3s` §5c.
