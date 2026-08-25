# LinkedIn Redirect URI — exact value to add

## One URL. Add it exactly. No trailing slash. No whitespace.

```
https://linkedin-oauth.weissvanderpol-ivan.workers.dev/auth/linkedin/callback
```

## Where

1. Go to https://www.linkedin.com/developers/apps
2. Click your app (`Ai-Whisperers Hermes` or whatever name)
3. Click the **Auth** tab
4. Scroll to **"OAuth 2.0 Redirect URLs"** (or "Authorized redirect URLs for your app")
5. Click **Add redirect URL** (or paste into the textarea)
6. Paste exactly: `https://linkedin-oauth.weissvanderpol-ivan.workers.dev/auth/linkedin/callback`
7. Click **Update** (some apps require clicking a Save button separately)
8. Wait 30-60 seconds for LinkedIn's cache to propagate

## Then retry the OAuth start

Open this URL in a browser:

```
https://linkedin-oauth.weissvanderpol-ivan.workers.dev/auth/linkedin/start
```

You should see LinkedIn's consent screen with the scope listed as:
- `openid profile email w_member_social`

Click **Allow**. You should land on a green success page:

```
LinkedIn connected ✓
Token expires in 60 days. Issued at 2026-08-25T15:...
```

If that page appears, the token is now in BWS (`LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_TOKEN_ISSUED_AT`, etc.) and ready for the `linkedin-mcp` server to use.

## What you saw earlier

You got the "redirect_uri does not match the registered value" error because that URL wasn't in your app's redirect list yet. The Worker is sending the correct URL — your app just doesn't have it registered.

## If you want the production hostname (auth.hermes.paragu-ai.com) instead

Skip this for now. The workers.dev URL works fine for testing. To migrate to auth.hermes.paragu-ai.com later:

1. Re-roll CF token with **Workers Custom Domains:Edit** sub-scope checked
2. Tell me — I'll call `POST /accounts/.../workers/domains` to provision the cert
3. Wait 60s for cert
4. Update Worker's `LINKEDIN_REDIRECT_URI` env to `https://auth.hermes.paragu-ai.com/auth/linkedin/callback`
5. Add that URL to LinkedIn's app redirect list
6. Same for Meta app's IG Login redirect list