---
type: learning
title: Nodes after the first do not install k3s in cloud-init — they wait at /etc/k3s-join-pending
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: terraform/cloud-init.yaml.tftpl
    commitSha: 6944a19d49e94a37072b3ff9c8ace8b8f71708b9
  - path: terraform/compute.tf
    commitSha: 6944a19d49e94a37072b3ff9c8ace8b8f71708b9
createdAt: 2026-09-02
lastVerifiedAt: 2026-09-02
---

## Trigger

Raising `node_count` above 1, then finding the new VM has no k3s running and
never joins the cluster.

## Context

`cloud-init` runs at provision time. The k3s **join token** is not known then
— it only exists after the first node has initialised the cluster.

## Business rule

Only `node[0]` installs k3s (`--cluster-init`). Every later node boots without
k3s and leaves the marker file **`/etc/k3s-join-pending`**.

## Resolution

The marker is deliberate. The alternative — running the same install on every
node — would silently stand up a **second, separate single-node cluster** that
looks healthy from `kubectl` on that node while sharing no state with the
first. A node that has visibly not joined is far safer than two clusters that
believe they are one.

Joining is TASK-1725 (P2). Until then a second node is provisioned
infrastructure, not cluster capacity.

### What `node_count = 2` was proven to do

`terraform plan -var node_count=2` produces exactly 5 changes, all `create`,
all at index `[1]`: VM, managed disk, NIC, NIC-NSG association, disk
attachment. Nothing touches the VNet, the three subnets, the NSG, the public
IP, or any `node[0]` resource. Plan only — never applied.
