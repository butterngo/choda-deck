# k3s on Azure — starter plugin

A Claude Code plugin for running a small-team Kubernetes platform on Azure: one
k3s node, managed and in-cluster databases, GitHub Actions CI/CD, and
observability that fits inside a hard cost ceiling.

It is distilled from a real Phase 1 delivery — roughly three and a half weeks of
work, 102 commits, and forty-two recorded failures. What is packaged here is the
part that was **platform behaviour rather than client configuration**.

## What it does and does not promise

**It carries:** the order the setup steps actually depend on each other, the
traps that cost time the first time, templates that are already correct, and a
verification discipline that refuses to pass on evidence that proves nothing.

**It does not carry the architecture.** Single node, k3s instead of managed
Kubernetes, one database managed and one in-cluster — those followed from one
client's cost ceiling, user count and a region whose quota was closed that month.
Change any of those inputs and the right answer changes. The plugin makes those
decisions fast and well-informed; it does not make them for you.

**It is not a production-readiness kit.** The delivery it came from was signed off
in writing as staging-grade. Disaster recovery, secret management, multiple
replicas and automated rollback were out of scope there, so they are absent here.

## Status

| Skill | State |
|---|---|
| `investigate` — symptom → log → trace → pod → image SHA → commit → author | first draft |
| `terraform` — safe plan/apply against a cost ceiling | first draft |
| `cluster` — reach and inspect the cluster without a tunnel | not written |
| `observability` — workspace, daily cap, alert rules, hourly cost view | not written |
| `bootstrap` — the gated setup sequence | not written |
| `templates/` — Terraform modules, k8s manifests, CI workflows | not extracted |

`knowledge/` holds 16 notes, scrubbed of client identifiers.

## Try it locally

```bash
claude --plugin-dir /path/to/k3s-azure-starter
```

Then `/k3s-azure:investigate "the site 500'd around 10am"`.

Validate the structure before sharing it:

```bash
claude plugin validate /path/to/k3s-azure-starter --strict
```

## Distributing it

Put a `.claude-plugin/marketplace.json` in a private repository listing this
plugin, then:

```bash
/plugin marketplace add <org>/<repo>
/plugin install k3s-azure@<marketplace-name>
```

A private marketplace avoids the executable restrictions the public one applies,
and keeps the client material where it belongs.

## Configuration

Values are prompted on enable — see `userConfig` in `.claude-plugin/plugin.json`.
The one that unlocks the most is `IMAGE_REPOS`: without a mapping from a running
deployment to its git repository, an investigation can identify the image SHA but
cannot walk to the commit.

## A precondition worth stating

Commit attribution works **only because images are tagged with the git SHA and
never with a moving tag**. If a client's pipeline pushes `latest`, the chain from
a failing pod to a commit is broken at the second hop, and no amount of
investigation recovers it. Fixing the tagging is the prerequisite, not an
optimisation.

## Building this out

Extract the remaining skills **while doing a real second engagement**, not in the
abstract. A plugin pulled out of one project and never used on a second is a guess
about what generalises.
