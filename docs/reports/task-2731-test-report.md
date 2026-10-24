---
goal: "TASK-2731"
generatedAt: "2026-10-24T12:09:15.944Z"
suite: {"passed":2777,"skipped":56,"failed":0}
testsAdded: 54
unreadableCommits: []
ac: {"covered":52,"weak":0,"open":0,"human":2,"total":54}
smoke: {"env":"local","base":"http://127.0.0.1:7348 (run-branch adapter 87a99d4, CHODA_DATA_DIR=C:/dev/choda-deck/data)","build":"87a99d4","ranAt":"2026-10-24T12:09:02.678Z","checks":[{"name":"tool round trip","call":"POST /assistant/chats/CHAT-5/messages (gpt-5.6-luna)","expect":"reply names IMPLEMENTED; get_task ok; tokens shown","got":"200; steps=get_task:true; tokens=3370; reply=\"IMPLEMENTED\"","ok":true},{"name":"meeting summary","call":"ask \"summarise meeting Kate jsp\" (m-mvktwtkq-xj1l8d)","expect":"the meeting's decisions from its stored note; steps and tokens shown","got":"200; note.json present=false (no meeting has a saved note yet — answered from the transcript); steps=find_meetings:true,get_meeting:true,get_meeting:true,get_meeting:true,get_meeting:true; reply=\"Assuming you mean the newest **“Kate jsp”** meeting (**ID: `m-mvktwtkq-xj1l8d`**, 23 Oct 2026), the decisions were:\n\n- Add **Scoring Context** and **Scoring Gui\"","ok":false},{"name":"vault with redaction","call":"ask \"what servers does Ichiba devops use?\"","expect":"answer drawn from the vault; IP addresses shown as [ip]","got":"200; vault tools=true; raw IPv4 in tool rows or reply=false; [ip] seen=true; reply=\"Ichiba DevOps uses these infrastructure components, according to the vault:\n\n- **Rancher production server** — Kubernetes management UI/API on port `9443`, acce\"","ok":true},{"name":"another model","call":"repeat check 1 on gpt-4.1-mini","expect":"a correct answer or the \"could not answer with tools\" error; never blank","got":"200; steps=get_task:true; reply=\"The status of TASK-2733 is IMPLEMENTED.\"","ok":true}],"data":["CHAT-5","CHAT-6","CHAT-7","CHAT-8"]}
regression: []
---

# Test report — TASK-2731

Generated 2026-10-24T12:09:15.944Z.

## Unit and integration suite

2777 passed, 56 skipped, 0 failed (newest item session with a suite line).

## Tests added by this run

54 test case(s) added across the run's commits.

## Acceptance criteria

52/54 covered · 0 weak · 0 open · 2 waiting on a person.

## Smoke

3/4 passed on local (http://127.0.0.1:7348 (run-branch adapter 87a99d4, CHODA_DATA_DIR=C:/dev/choda-deck/data), build 87a99d4, ran 2026-10-24T12:09:02.678Z).

| Check | Call | Expect | Got | Result |
|---|---|---|---|---|
| tool round trip | POST /assistant/chats/CHAT-5/messages (gpt-5.6-luna) | reply names IMPLEMENTED; get_task ok; tokens shown | 200; steps=get_task:true; tokens=3370; reply="IMPLEMENTED" | pass |
| meeting summary | ask "summarise meeting Kate jsp" (m-mvktwtkq-xj1l8d) | the meeting's decisions from its stored note; steps and tokens shown | 200; note.json present=false (no meeting has a saved note yet — answered from the transcript); steps=find_meetings:true,get_meeting:true,get_meeting:true,get_meeting:true,get_meeting:true; reply="Assuming you mean the newest **“Kate jsp”** meeting (**ID: `m-mvktwtkq-xj1l8d`**, 23 Oct 2026), the decisions were:  - Add **Scoring Context** and **Scoring Gui" | FAIL |
| vault with redaction | ask "what servers does Ichiba devops use?" | answer drawn from the vault; IP addresses shown as [ip] | 200; vault tools=true; raw IPv4 in tool rows or reply=false; [ip] seen=true; reply="Ichiba DevOps uses these infrastructure components, according to the vault:  - **Rancher production server** — Kubernetes management UI/API on port `9443`, acce" | pass |
| another model | repeat check 1 on gpt-4.1-mini | a correct answer or the "could not answer with tools" error; never blank | 200; steps=get_task:true; reply="The status of TASK-2733 is IMPLEMENTED." | pass |

Test data created: "CHAT-5", "CHAT-6", "CHAT-7", "CHAT-8".

## Regression scope

No other finished task realizes this goal's feature.

## Items

| Task | AC covered | Tests added | Suite line |
|---|---|---|---|
| TASK-2732 Amend the model-call ADR for the companion chat assistant | 6/6 | 0 | full suite: 2732 passed, 56 skipped, 0 failed |
| TASK-2733 Assistant storage and chat routes in the companion adapter (no model call) | 8/8 | 11 | full suite: 2743 passed, 56 skipped, 0 failed |
| TASK-2734 Assistant read-only tools with redaction and a 16000-character cap | 11/11 | 16 | full suite: 2759 passed, 56 skipped, 0 failed |
| TASK-2735 Assistant message route: the 8-step read-only tool loop on Azure chat completions | 13/13 | 13 | full suite: 2772 passed, 56 skipped, 0 failed |
| TASK-2736 Companion Assistant view: chat list, model picker, steps and tokens under each reply | 8/10 | 9 | full suite: 1214 passed, 0 skipped, 0 failed |
| TASK-2743 Assistant redaction masks string values, not the whole JSON tool result | 6/6 | 5 | full suite: 2777 passed, 56 skipped, 0 failed |
