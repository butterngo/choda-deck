# Plugins

Claude Code plugins distributed from this repository. The marketplace manifest at
`.claude-plugin/marketplace.json` (repo root) lists what is installable; each
plugin lives in its own directory here.

Nothing in this directory is published to npm — `package.json` uses an explicit
`files` allowlist covering only `dist/`, README and LICENSE — so adding a plugin
has no effect on the `choda-deck` package.

## Inventory

| Plugin | Does | State |
|---|---|---|
| `k3s-azure` | Operate a small-team k3s cluster on Azure: incident investigation from symptom to commit, Terraform against a cost ceiling, tunnel-free cluster access, capped observability | 2 of 5 skills drafted |

## Using them locally

```bash
claude --plugin-dir ./plugins/k3s-azure
```

Local plugins load in place and are never cached, so an edit takes effect on the
next session — which is what makes this the right loop while a plugin is still
being written.

## Installing from the marketplace

```bash
/plugin marketplace add <org>/choda-deck
/plugin install k3s-azure@choda
```

Skills are namespaced by plugin name and there is no opt-out, so the example above
is invoked as `/k3s-azure:investigate`.

## Adding another plugin

1. `plugins/<name>/.claude-plugin/plugin.json` — manifest. Only this file goes
   inside `.claude-plugin/`; `skills/`, `agents/`, `hooks/`, `bin/` and any
   templates sit at the plugin root.
2. Add an entry to the root `.claude-plugin/marketplace.json`.
3. `claude plugin validate ./plugins/<name> --strict` — it catches real schema
   errors, including required fields the documentation does not emphasise.
4. Bump the `version` in both files when you want installed copies to update.
   Users receive nothing until that number changes, and their configuration
   values are **not** migrated between versions.

## The standard this directory holds itself to

A plugin here is extracted from work that actually happened, and it carries the
failures that work paid for. Two rules follow:

- **Scrub before it ships.** Knowledge notes written during a client engagement
  carry that client's hostnames, resource groups and database names. Check with a
  case-insensitive search, then check again — the first pass usually misses the
  lowercase spelling.
- **Say what is not built.** Each plugin's README states which skills exist and
  which are still empty. A plugin that implies more coverage than it has costs
  more than one that admits the gap.
