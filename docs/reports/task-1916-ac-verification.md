---
task: TASK-1916
title: Run ac_review for real and judge whether its verdicts are worth acting on
verified: 2026-09-09
session: SESSION-1788943049936-1
also settles: TASK-1860 AC-7 (unticked since 2026-09-05), TASK-1914 AC-7
---

# AC verification — TASK-1916

**Done: 4/4. All human-class, judged by Butter in an attended session.**

The audit the whole `ac_review` chain leaned on. TASK-1915 chose *advisory, not
blocking* on the stated grounds that nobody had checked the grader's judgement.
This is that check.

## The ten verdicts on TASK-1839, verbatim

All ten `ok`, no concerns, no suggestions. Indexes 0-9, each row's `text` matching
the criterion at that index.

That is a **result about the criteria**, not yet about the grader: TASK-1839's
criteria name status codes (403/400/409/404), byte-identity, and "no outbound
request". A grader that always says `ok` produces exactly this output on exactly
this task. So it needed a control.

## The control — TASK-1103, and where it earned its keep

Same standard, criteria written in the older style. Four `weak`, four concerns:

| AC | Concern | Agreed? |
|---|---|---|
| AC-1 | "starts the server" names no observation point — no log, process or response to check | **yes** |
| AC-2 | two claims in one line, violating one-verdict | **yes** (it said "joined with 'and'"; the joiner is a semicolon — right finding, loose wording) |
| AC-3 | not falsifiable; no statement of what failure looks like | **yes** |
| AC-4 | "not clearly tickable as a checkbox line" | **no** — it IS a checkbox. The rest of the concern ("no observable measure") is right, so: real weakness, wrong test named |

Three of four are findings a person agrees with, and they are not
obvious-without-a-model — they are the five tests applied to prose nobody had
re-read since June.

## No false `ok`

Walked all ten TASK-1839 criteria and stated what a broken implementation would
produce for each: the four status codes, differing bytes on the BOM round-trip, a
request leaving the machine, a provider call, a route-table walk, the file
changing, and `git diff` showing the whole file. Every one discriminates.

The error direction is also known now, and it is the safer one: on TASK-1105 the
grader called three sound criteria `weak`. It over-flags rather than over-approves.

## Two failures a veto would have made expensive

**TASK-1105** — it flagged all four criteria with the same concern ("surface not
named"), three of them wrongly, and **missed the one that is genuinely broken**:
AC-4 reads *"For Option B, the `@latest` snippet is only documented after
TASK-1104 publishes"* — and Option B was cancelled, so that condition can never
obtain. A criterion that can never be exercised, graded `weak` for a reason that
is not its problem.

**TASK-1791** — index 5 (AC-6, renames) came back `weak` with a concern about the
**size cap** and a suggestion rewriting **AC-5** verbatim. The verdict was filed
against one criterion and the reasoning belongs to its neighbour. Seven rows for
seven criteria, so `unanswered` never fired.

That second one is the risk TASK-1913's handoff recorded as uncovered, four hours
before it happened. Ticketed as **TASK-1920**.

## Verdict on the verdicts (AC-4)

**Confirms advisory; does not justify revisiting it.**

Across five gradings the grader is silent where silence is right (1839 10/10,
1792 8/8, 1791 6/7), sharp where it counts (1103, 4/4 agreed), and wrong in two
distinct ways — misjudging sound criteria, and attributing a concern to the wrong
line. A reader can absorb both in a sentence. A gate could not: it would withhold
a task over a concern about a different criterion, and the person would be
arguing with a machine about a line the machine was not looking at.

TASK-1915's reasoning was *"a model that has never been audited does not overrule
the person who has."* The audit is done, and the answer is the same — now on the
evidence rather than on the absence of it.
