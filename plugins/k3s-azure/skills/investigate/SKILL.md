---
name: investigate
description: >
  Take an incident from a symptom to the change that caused it, on a k3s cluster
  whose images are tagged with git SHAs. Walks one chain — symptom, time window,
  log line, trace id across services, the pod that served it, the image SHA, the
  commit range since the previous deploy, the author to ask — and stops at the
  first link that cannot be evidenced rather than guessing past it. Classifies the
  fix by the kind of work it needs (config / code / migration / decision) instead
  of inventing an hour estimate. Knows the failure modes that look like something
  else: a pod whose phase reads Running while its readiness probe fails, an
  aggregated Kubernetes event whose timestamp is frozen at the first occurrence, a
  cheap-tier log table that the normal query API refuses, a cluster that looks
  down when it is only the local proxy that died, and a migration failure that
  leaves the pod Ready. Trigger with "/k3s-azure:investigate", "investigate this
  error", "why did the site 500", "which deploy broke this", "trace this request",
  or when handed an alert, a stack trace, or a time when something went wrong.
---

# Investigate an incident

Produce a report that separates what was **observed** from what was **inferred**,
and names the change responsible when — and only when — the chain holds.

## The rule that matters more than the steps

**Every claim is labelled with how it is known.** Use exactly these:

| Label | Means |
|---|---|
| `OBSERVED` | A log line, a query result, a command's output. Quote it. |
| `DERIVED` | Follows mechanically from something observed (pod → image tag → commit). |
| `INFERRED` | A judgement. Say what would confirm or refute it. |
| `UNKNOWN` | The chain broke here. Say which link and why. |

A report that reaches `UNKNOWN` at step 4 is more useful than one that reaches a
confident wrong answer at step 7. Do not smooth over a broken link.

## Step 0 — establish access before concluding anything

🔴 **A dead local proxy looks exactly like a dead cluster.** `kubectl` failing with
`dial tcp 127.0.0.1:<port>: connection refused` means the Arc proxy process on
*this machine* is gone, not that the cluster is down. Check the cluster from Azure
before reporting an outage:

```bash
az connectedk8s show -n "$ARC_CLUSTER" -g "$RESOURCE_GROUP" \
  --query "{connectivity:connectivityStatus,lastConnect:lastConnectivityTime}" -o json
```

`Connected` with a recent `lastConnect` means the cluster is fine. Restart the
proxy (`az connectedk8s proxy -n "$ARC_CLUSTER" -g "$RESOURCE_GROUP"`, long-running,
needs its own shell) and continue.

Also confirm the VM is actually running — a deliberately stopped cluster is a
cost-saving measure here, not a fault, and every other command will fail in ways
that read as faults.

## Step 1 — pin the window

Get a start time, even a rough one. "This morning" becomes a UTC range.

⚠️ **The cluster's clock is UTC and the reporter's is not.** Convert once, state
both, and use UTC everywhere after that. Most wasted investigations start with a
seven-hour offset.

If the trigger is an Azure alert, it already carries the window and the failing
resource — read it rather than re-deriving it:

```bash
az rest --method get --url "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.AlertsManagement/alerts/<id>?api-version=2019-05-05-preview"
```

🔴 **Fetch alerts one by one, never from the list endpoint.** The list response is
a summary whose `dimensions` array is **always empty**, including for alerts that
do carry the failing pod's name. Reading the list will tell you the alert names
nothing, which is false.

## Step 2 — find the log line

Two stores, and they answer different questions:

- `kubectl logs` — immediate, but dies with the pod and rotates under load.
  Useless for anything older than the current pod.
- The log workspace — survives the pod. This is where an incident that already
  ended has to be read.

🔴 **Container logs may sit on a cheap tier that the normal query API refuses.**
If a query returns `UnsupportedApiQueryValidationError`, the table is on the Basic
plan: use the `/search` endpoint instead of `/query`. Consequence worth knowing —
`union withsource=T *` **silently omits** Basic tables, so a table that is
collecting perfectly will appear empty.

```
POST https://api.loganalytics.io/v1/workspaces/<guid>/search
{ "query": "ContainerLogV2 | where TimeGenerated between (...) | where LogMessage contains '...'", "timespan": "PT1H" }
```

⚠️ `has` tokenises on punctuation, so `has "abc-123-def"` will not match. Use
`contains` for ids, hashes and hyphenated markers.

⚠️ **Ingestion lags by a minute or two.** An empty result seconds after the event
means "not yet", not "never". Re-query before concluding the logs are missing.

## Step 3 — expand the trace

If a line carries a trace id, that id is the whole request across every service.
Search it alone — do not filter by service, which is what hides the hop you need:

```
ContainerLogV2 | where LogMessage contains '<traceid>'
| project TimeGenerated, PodName, ContainerName, LogMessage
| order by TimeGenerated asc
```

Read the result for **where the chain stops**. Lines from service A and none from
service B means either B never got the request, or B does not log that path. Those
are different diagnoses; distinguish them by whether A logged an outgoing call.

🔴 **Asynchronous work loses the trace id.** Anything handed to a background worker
or queue logs without it. A trace that ends at "queued for X" has not failed — it
has left the traced path. Follow it by entity id from there.

🔴 **No trace id anywhere does not mean tracing is broken.** Check whether the
service logs HTTP requests at all. Some services only stamp trace ids onto lines
the application already writes, so a request that touches no logging handler — a
404, a rejected auth — leaves **no record whatsoever**. Absence of a line is not
evidence the request did not arrive.

## Step 4 — identify the pod, and read its state honestly

```bash
kubectl --context "$KUBE_CONTEXT" -n "$APP_NAMESPACE" get pods -o wide
kubectl --context "$KUBE_CONTEXT" -n "$APP_NAMESPACE" describe pod <name>
```

🔴 **`Running` is a phase, not health.** A pod whose readiness probe fails
continuously reports phase `Running` while serving no traffic — this is the single
most misread state on this platform, and it is what let a broken deploy sit
unnoticed for seventeen hours. Read the `Ready` condition and the readiness-probe
events, not `STATUS`.

Check for the shapes that mimic application bugs:

- **Rollout stuck** — new ReplicaSet at 0 ready while the old one still serves. The
  site returns 200 throughout, so nothing external looks wrong.
- **Migration failure swallowed** — a service that catches migration errors and logs
  them as a warning comes up `Ready` with a half-migrated database. Grep the startup
  log for the warning explicitly; pod health proves nothing about it.
- **Stale manifest** — a manifest naming an older image than what is deployed turns
  the next `apply` into a silent rollback that reports success.

## Step 5 — walk from the pod to the commit

This is the chain the report exists to produce. Every hop is `DERIVED`, not guessed:

```bash
# pod -> image (the tag IS the commit SHA; this setup never uses `latest`)
kubectl --context "$KUBE_CONTEXT" -n "$APP_NAMESPACE" \
  get deploy <name> -o jsonpath='{.spec.template.spec.containers[0].image}'

# when did this version arrive, and what did it replace
kubectl --context "$KUBE_CONTEXT" -n "$APP_NAMESPACE" get rs -l app=<name> \
  --sort-by=.metadata.creationTimestamp
```

🔴 **If the tag is `latest` or any moving tag, the chain ends here.** Report
`UNKNOWN` for commit attribution and say why — the fix is a registry-tagging
change, not more investigation.

Then, in the matching repository from `IMAGE_REPOS`:

```bash
git log --oneline <previous-sha>..<running-sha>      # everything in this deploy
git log -1 --format='%h %an %ae %ad %s' <running-sha>
git log -S'<symbol from the stack trace>' --oneline <previous-sha>..<running-sha>
git blame -L <line>,<line> -- <file>                 # who last touched the line
```

Narrow by the failing path. A deploy of forty commits with one that touches the
failing file is a strong `INFERRED`; forty commits with none touching it means the
cause is probably configuration or data, not code — say so rather than picking a
commit to blame.

**On naming the author.** Record who wrote the change, because they understand it
best and asking them is the fastest route to a fix. Frame it as *which change
introduced this, and who can explain it* — never as fault. A tool that reads as
blame teaches people to hide incidents, which costs more than any single bug.

## Step 6 — match against known traps before theorising

Check `${CLAUDE_PLUGIN_ROOT}/knowledge/` for a note matching the symptom. These are
failures already paid for once; a match turns a multi-hour investigation into a
known fix. Search by symptom words, not by cause — the reader does not yet know
the cause.

## Step 7 — classify the fix, do not invent a duration

State what **kind** of work the fix is. This tells the reader the risk and who is
needed, which an hour estimate does not:

| Class | Means | Carries |
|---|---|---|
| `config` | A variable, a manifest value, a rule | No rebuild; fast to revert |
| `code` | A source change | Needs CI, a new image, a rollout |
| `migration` | Touches schema or data | **One-way.** Needs a backup taken first, and a redeploy does NOT undo it |
| `decision` | A trade-off, not a defect | Needs a person to choose, not an engineer to type |

Give a duration **only** by comparison to a recorded similar fix, and label it
`INFERRED` with the comparison named. An unqualified number will be read as a
commitment.

## Output

```
SYMPTOM      what was reported, and the UTC window
OBSERVED     the log lines, quoted, with timestamps and pod names
TRACE        the id, which services it spans, where it stops
DEPLOY       running image SHA, when it rolled out, what it replaced
CHANGE       the commit range; the suspected commit and its author, or UNKNOWN
CAUSE        what actually broke — labelled OBSERVED / DERIVED / INFERRED
KNOWN TRAP   matching note, if any
FIX          the change, and its class (config / code / migration / decision)
UNKNOWNS     every link that did not hold, and what would close it
```

Lead with `CAUSE` when it is `OBSERVED`. Lead with `UNKNOWNS` when it is not —
that is the honest headline, and it tells the reader where to look next.

## Rules

- **Never report an outage without checking the cluster from Azure.** The local
  proxy dies far more often than the cluster does.
- **Never attribute a commit through a moving tag.** Report `UNKNOWN` instead.
- **Never present an inferred cause as observed.** The labels are the deliverable.
- **Read-only by default.** Investigating does not fix. Propose the change; let a
  person apply it — especially anything classed `migration`.
- **A quiet signal is not a healthy one.** Before concluding "no errors", confirm
  the telemetry was actually flowing in that window. Silence from a stopped
  collector looks identical to silence from a healthy system.
