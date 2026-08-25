# linkedin-oauth — Cloudflare Worker

OAuth 2.0 authorization-code callback for the Hermes LinkedIn integration.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET  | `/auth/linkedin/start` | Generate state, 302 to LinkedIn authorize URL |
| GET  | `/auth/linkedin/callback` | Exchange code, write token to BWS |
| POST | `/auth/linkedin/refresh` | Exchange refresh_token for a new access_token |
| GET  | `/healthz` | Liveness probe |

## Required secrets (set with `wrangler secret put`)

```
LINKEDIN_CLIENT_ID                 your app's client id
LINKEDIN_CLIENT_SECRET             your app's client secret
LINKEDIN_REDIRECT_URI              https://hermes.paragu-ai.com/auth/linkedin/callback
LINKEDIN_SCOPES                    "openid profile email w_member_social"
                                   (add w_organization_social r_organization_social
                                    once Community Mgmt API partner approval is granted)
BWS_ACCESS_TOKEN                   Bitwarden Secrets Manager service-account token
BWS_BASE_URL                       https://vault.bitwarden.com/api  (or self-host URL)
BWS_SECRET_ID_ACCESS_TOKEN         UUID of the LINKEDIN_ACCESS_TOKEN secret
BWS_SECRET_ID_ISSUED_AT            UUID of the LINKEDIN_TOKEN_ISSUED_AT secret
BWS_SECRET_ID_SCOPES               UUID of the LINKEDIN_TOKEN_SCOPES secret
BWS_SECRET_ID_REFRESH_TOKEN        UUID of the LINKEDIN_REFRESH_TOKEN secret (optional)
```

## KV namespace

Create a KV namespace binding called `OAUTH_STATE`. The wrangler.toml has a placeholder ID you need to replace:

```bash
wrangler kv:namespace create OAUTH_STATE
# copy the returned id into wrangler.toml under [[kv_namespaces]]
```

## Deploy

```bash
cd linkedin-oauth-worker
npm install
# Set all secrets first (one per command — values are write-once, secret):
  wrangler secret put LINKEDIN_CLIENT_ID
  wrangler secret put LINKEDIN_CLIENT_SECRET
  wrangler secret put LINKEDIN_REDIRECT_URI
  wrangler secret put LINKEDIN_SCOPES
  wrangler secret put BWS_ACCESS_TOKEN
  wrangler secret put BWS_BASE_URL
  wrangler secret put BWS_SECRET_ID_ACCESS_TOKEN
  wrangler secret put BWS_SECRET_ID_ISSUED_AT
  wrangler secret put BWS_SECRET_ID_SCOPES
  wrangler secret put BWS_SECRET_ID_REFRESH_TOKEN     # optional
# Then deploy:
wrangler deploy
```

## DNS / hostname

Route `auth.hermes.paragu-ai.com` → this Worker. Then on LinkedIn App settings, set the Authorized redirect URL to:
`https://auth.hermes.paragu-ai.com/auth/linkedin/callback`

## Trademark

This Worker is `linkedin-oauth`. Do not rename it to anything containing upstream product trademarks — see `/opt/data/integrations/linkedin-mcp/references/trademark.md`.