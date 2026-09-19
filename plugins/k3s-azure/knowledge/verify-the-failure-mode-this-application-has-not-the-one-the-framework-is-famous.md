---
type: learning
title: Verify the failure mode this application has, not the one the framework is famous for
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs:
  - path: k8s/base/api-keyring-pvc.yaml
    commitSha: 8daab1a0f9229e54e12daa6e195022261497b5b3
  - path: k8s/base/api-deployment.yaml
    commitSha: 8daab1a0f9229e54e12daa6e195022261497b5b3
createdAt: 2026-09-12
lastVerifiedAt: 2026-09-12
---

## Trigger

You are writing an acceptance criterion for a well-known framework behaviour —
"ASP.NET Core DataProtection keys are lost on restart" — and reaching for the
textbook symptom to test against.

## What happened

TASK-1723's original fourth criterion was *a browser session survives a pod
restart*. It is the standard ASP.NET Core failure mode and it was **wrong for this
application**. Reading the code first, before implementing, is what caught it:

- Authentication is **JWT bearer** (`JM_BE.API/Program.cs:131`), signed with a
  symmetric secret from configuration.
- Refresh tokens are **rows in the database** (`JM_BE.Domain/Entities/RefreshToken.cs`).
- Neither reads the DataProtection keyring. **A restart logs nobody out.**
- The only non-test consumer of `IDataProtectionProvider` is
  `AccountSetupTokenProvider` (`JM_BE.Infrastructure/Identity/AccountSetupTokenProvider.cs:29`).

So the criterion could not have failed whether or not the keys reached the volume.
It would have passed a broken implementation — the exact defect it existed to catch.

## The real failure mode

Every outstanding **account-setup, password-reset and email-confirmation link**
already sitting in someone's inbox stops working after any restart or redeploy. It
surfaces to the user as "invalid token", which reads like a bad link rather than a
moved key — so it is unlikely to be reported as an infrastructure problem at all.

`AddDataProtection()` was never called, so the keyring defaulted to
`/home/app/.aspnet/DataProtection-Keys`, a directory the Dockerfile creates at
`JM_BE/Dockerfile:21` and which dies with the container. This bites at a **single
replica** — it is not a multi-replica concern.

## The criterion that replaced it

Issue a setup link, `kubectl delete pod`, redeem the link afterwards — and run the
**other half too**: prove the same link is rejected when the keyring is not
persisted. A criterion that only ever runs its passing half is not evidence.

## Business rule

Before writing an acceptance criterion against framework behaviour, find the
application's actual consumer of that mechanism in the code. The blast radius you
assume decides what you test, and a famous failure mode is a hypothesis about this
codebase, not a fact about it.

## Related

- [[a-probe-that-cannot-fail-is-not-a-probe-force-the-500-and-match-the-probe-type-t]] — the same discipline applied to probes
