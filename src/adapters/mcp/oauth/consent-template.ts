// ADR-027: Minimal consent screen rendered server-side for GET /authorize.
// Form POSTs back to /authorize with all the original params plus the
// pre-shared password. Markup is intentionally trivial — no template engine,
// no client JS. All user-supplied values are escaped before interpolation.

export interface ConsentParams {
  clientName: string
  clientId: string
  redirectUri: string
  state: string | null
  codeChallenge: string
  codeChallengeMethod: 'S256'
  responseType: 'code'
  errorMessage?: string
}

export function renderConsentScreen(params: ConsentParams): string {
  const errorBlock = params.errorMessage
    ? `<p class="err">${escapeHtml(params.errorMessage)}</p>`
    : ''
  const stateField =
    params.state === null
      ? ''
      : `<input type="hidden" name="state" value="${escapeHtml(params.state)}" />`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Authorize ${escapeHtml(params.clientName)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #111; }
    h1 { font-size: 1.25rem; }
    .client { background: #f5f5f5; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; font-family: ui-monospace, monospace; font-size: 0.875rem; }
    label { display: block; margin-top: 1rem; font-size: 0.9rem; }
    input[type=password] { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; }
    button { margin-top: 1rem; padding: 0.5rem 1.25rem; font-size: 1rem; cursor: pointer; }
    .err { color: #b00020; margin-top: 1rem; font-size: 0.9rem; }
    .meta { color: #666; font-size: 0.8rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>Authorize access</h1>
  <p>An application wants to connect to your choda-deck MCP server.</p>
  <div class="client">
    <div><strong>${escapeHtml(params.clientName)}</strong></div>
    <div>${escapeHtml(params.clientId)}</div>
    <div>Redirect: ${escapeHtml(params.redirectUri)}</div>
  </div>
  ${errorBlock}
  <form method="POST" action="/authorize">
    <input type="hidden" name="response_type" value="${escapeHtml(params.responseType)}" />
    <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}" />
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}" />
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}" />
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}" />
    ${stateField}
    <label for="password">Consent password</label>
    <input id="password" name="consent_password" type="password" autocomplete="off" autofocus required />
    <button type="submit">Approve</button>
  </form>
  <p class="meta">choda-deck OAuth 2.0 + DCR (ADR-027)</p>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
