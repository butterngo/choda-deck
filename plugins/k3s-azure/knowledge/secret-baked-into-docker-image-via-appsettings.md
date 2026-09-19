---
type: learning
title: Secret rò rỉ vào layer của Docker image qua appsettings.json — .dockerignore không chặn file chính
projectId: juvenis-maxime
workspaceId: juvenis-maxime-devops
scope: project
refs: []
createdAt: 2026-08-26
lastVerifiedAt: 2026-08-26
---

> Title kept in Vietnamese: knowledge frontmatter titles are immutable, and the
> slug is derived from it. Body translated to English 2026-09-03.

# A secret leaked into a Docker image layer through `appsettings.json`

## Trigger

Filling a real value into `src/JM_BE.ChatEngine/appsettings.json` to try an
integration — then building the image.

Happened for real on 2026-08-26 with `Content:SharePoint:ClientSecret`.

## Why it got through

The repo's `.dockerignore` excludes `**/appsettings.Development.json`, but does
**not** exclude `appsettings.json`. That is deliberate — the main file holds the
default configuration the app needs. The consequence, though, is that **every
value in it lands in an image layer**:

```
COPY --from=build /app .    # /app already contains appsettings.json with the real value
```

Three things make this worse than it looks:

1. **Editing the file and restarting does not erase it.** The secret lives in a
   sealed layer — the image must be **rebuilt**.
2. **If the image was ever pushed to a registry, the secret went with it**, and
   it remains in the layer history even if the tag is overwritten.
3. **`git` does not catch it.** In this instance `git HEAD` still held the
   placeholder — the secret existed only in the uncommitted working tree. Every
   git-based secret scanner reports clean while the running image is not.

That last point is the real lesson: **"not committed" does not mean "not
distributed"**. Docker build reads the working directory, not git.

## Business rule

Secret values **never** live in a file that gets `COPY`ed into the image. The
app's design already enforces this — `appsettings.json` carries only the **name**
of an environment variable:

```json
"ClientSecret": "",
"ClientSecretEnvVar": "CHATENGINE_SHAREPOINT_SECRET"
```

Changing that to an inline `ClientSecret` breaks exactly that protection.

## Resolution

Keep `appsettings.json` as placeholders and pass values as environment variables
in compose. ASP.NET Core reads nested configuration via **double underscores**:

```yaml
      CHATENGINE_SHAREPOINT_SECRET:    ${CHATENGINE_SHAREPOINT_SECRET:?}
      Content__SharePoint__TenantId:   ${SP_TENANT_ID:?}
      Content__SharePoint__ClientId:   ${SP_CLIENT_ID:?}
      Content__SharePoint__SiteId:     ${SP_SITE_ID:?}
      Content__SharePoint__FolderPath: ${SP_FOLDER_PATH:?}
```

`Content__SharePoint__X` overrides `Content:SharePoint:X`. The values live in
`/opt/jm-chatengine/.env` (chmod 640) with a lookup copy in
`sensitive_information/docker_env.txt` (gitignored).

Rotating a secret now takes an `.env` edit plus `up -d` — **no rebuild**. That
is the payoff of this approach, on top of a clean image.

## The discriminating test

Two checks run together; each is meaningless alone:

```bash
# 1. The new image no longer carries the secret
docker exec chatengine sh -c 'grep -o "\"ClientSecret\": *\"[^\"]*\"" /app/appsettings.json'
#    -> "ClientSecret": ""

# 2. And SharePoint import still works
curl -X POST https://ai.acme.com/v1/content/import \
     -H "X-Api-Key: <admin>" -d '{"dryRun": true}'
#    -> completed, 26 + 9 tasks
```

Check (1) alone proves nothing — the configuration could be entirely broken.
Check (2) alone proves nothing either — it might still be reading the old secret
baked into the image. **The pair** proves both: the image is clean **and** the
configuration genuinely comes from the environment.

## Cleanup after the incident

Contaminated images must be deleted, not merely superseded:

```bash
docker image rm jm-chatengine:2.0     # the build with the secret in a layer
```

Whether to rotate depends on exposure. This time: never in git, never pushed to
a registry, existing only in one image on the VPS itself → low risk, but
rotating is still the right call if you want certainty. Under the new approach,
rotating costs one `.env` edit.

## Related

- [[chatengine-deploy-ai-subdomain-nginx-tls]] — where this stack is deployed
- [[live-secrets-committed-in-appsettings-development-json-blanked-prod-secrets-rema]]
  — same family of problem, but the distribution path is **git**. This entry is
  the **image** path. The two are independent: blocking git does not block the
  image.
