---
type: learning
title: A GitHub runner's identity lives in its install directory, so the volume must hold the whole install
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: k8s/overlays/azure/github-runner.yaml
    commitSha: 965f3b0f11c8243f440b50262ba448012c80b8f0
createdAt: 2026-09-10
lastVerifiedAt: 2026-09-10
---

## Trigger

Either of these, hours or months after a runner that looked healthy on day one:

- the pod crash-loops after a restart, failing inside `config.sh` against a registration token that expired an hour after it was minted;
- the pod dies immediately with `bash: line N: /home/runner/run.sh: No such file or directory`, which reads as a broken image.

## The mistake

Mounting the PVC at a *subdirectory* and pointing `--work` at it:

```yaml
volumeMounts:
  - name: state
    mountPath: /home/runner/state
...
--work /home/runner/state/_work
```

This persists `_work` — the one thing that does not matter — and leaves `.runner`, `.credentials` and `.credentials_rsaparams` on the container filesystem, because **the runner writes its identity into its install directory, never into `--work`.** Every restart therefore re-registers. It works on day one only because the registration token is still valid; the failure waits for the first restart after it expires.

A guard like `if [ ! -f /home/runner/state/.runner ]` looks like it prevents exactly this and cannot, because nothing ever creates that file.

## Two fixes that do not work — both tried against the live pod

**`RUNNER_ROOT` does not relocate them.** Set to `/home/runner/state` and read back inside the pod with `printenv`, the runner's own log still named `/home/runner/.credentials_rsaparams`.

**Symlinks are refused outright.** Linking the three files onto the volume fails with an unhandled exception:

```
System.IO.FileNotFoundException: Could not find file '/home/runner/.credentials'.
   at SafeFileHandle.Open(..., Boolean failForSymlink, ...)
```

`failForSymlink` is deliberate on the runner's side. A dangling symlink reads as *absent*, not as a link to follow.

## What works

Mount the volume **at** `/home/runner` and seed the install from the image in an initContainer. The runner's in-place self-update then survives restarts too, rather than being reverted to the pinned tag by every new pod.

Three details, each of which failed first:

1. **Size the init container for the copy, not for the download.** The seed was OOM-killed at 64Mi — `exit 137`, nothing in the container log, visible only in `.status.initContainerStatuses[0].lastState.terminated`. The install is ~500 MB; the limit is now 256Mi.
2. **Copy entry by entry, not `cp -a /home/runner/.`** The trailing `.` makes cp stamp the *destination root*, which is the mount point owned `root:1001`. It fails with `preserving times for '/runner-home/.': Operation not permitted` **after** copying most of the tree, so with `set -e` the seed dies at the very end.
3. **Guard on a marker written after the copy**, never on the presence of a copied file. An interrupted seed leaves `config.sh` in place while `run.sh` is missing, and the next init then declares the volume already seeded — producing the "broken image" symptom above.

## How to know it actually works

Not by the pod being green. Rewrite the token Secret with an **invalid** value, then delete the pod: if it comes back `Listening for Jobs`, the credentials really came from the volume. If it re-registers, it fails loudly instead of passing on a token that merely happened to still be valid.

## Consequence worth remembering

Losing the PVC now loses both the registration **and** the install. Recovery needs a fresh registration token (repository admin) and has never been exercised. The `github-runner-token` Secret currently holds the invalid value left from the test above — harmless while the volume survives, and a crash loop on the day it does not.

## Related

- Pairs with [[a-federated-credential-s-subject-is-what-github-sends-not-what-the-documentation]] — both are faults a clean apply and a green plan could not reveal.
- TASK-1730 (P7a), commit `1c3c768`, PR juvenis-maxime-ops#8.
