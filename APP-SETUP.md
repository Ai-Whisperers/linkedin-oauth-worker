# LinkedIn App Setup — current state + exact fixes needed

App name: **solstein** (App ID `866f519qy3n78x`)
Created: March 5, 2026
Verified: March 5, 2026
LinkedIn Page: AI whisperer Py

## ✅ Already done (from your screenshot)
- Both redirect URLs registered: `https://auth.hermes.paragu-ai.com/auth/linkedin/callback` and `https://linkedin-oauth.weissvanderpol-ivan.workers.dev/auth/linkedin/callback`
- Client ID + Client Secret generated
- App type: Standalone app
- Access token TTL: 2 months

## ❌ Missing — Products not enabled

The OAuth flow needs two products enabled. Without them, LinkedIn returns `invalid_scope_error: The requested permission scope is not valid`.

### Step 1 — Enable "Sign In with LinkedIn using OpenID Connect"

1. Go to https://www.linkedin.com/developers/apps → click **solstein**
2. Click the **Products** tab (left nav)
3. Find **"Sign In with LinkedIn using OpenID Connect"** (Standard Tier — already approved for new apps)
4. Click the **"Request access"** button OR **"Add product"** (the wording varies)
5. For Standard Tier on this product, **access is usually auto-granted** for OpenID Connect
6. Wait for the status to show "Standard Tier" or "Access granted" (vs "Pending review")

This product unlocks the `openid`, `profile`, and `email` scopes.

### Step 2 — Enable "Share on LinkedIn"

1. Same Products tab
2. Find **"Share on LinkedIn"** (Default Tier — auto-granted for most apps)
3. Click **"Request access"** / **"Add product"**
4. Default Tier is typically instant — no App Review needed for the *product access* itself
5. Wait for "Standard Tier" or "Access granted" status

This product unlocks the `w_member_social` scope (the one we need for posting).

## What the OAuth flow will do once both products are enabled

1. User opens `https://linkedin-oauth.weissvanderpol-ivan.workers.dev/auth/linkedin/start`
2. Worker redirects to LinkedIn's consent screen
3. LinkedIn shows the consent screen with the scopes:
   - "Sign you to using your LinkedIn profile" (from Sign In with LinkedIn product)
   - "Post, comment and like posts on your behalf" (from Share on LinkedIn product)
4. User clicks **Allow**
5. LinkedIn redirects back to Worker callback with `?code=...&state=...`
6. Worker exchanges code for access token (60-day TTL)
7. Worker writes token to BWS
8. Worker returns green "LinkedIn connected ✓" page

## App Review for posting (later, separate step)

Even after both products are enabled, the **act of posting** via API requires the `w_member_social` scope to be **granted by App Review** for the **Sign In with LinkedIn** + **Share on LinkedIn** products. The submission text is in `/opt/data/integrations/linkedin-mcp/linkedin-app-review/APP-REVIEW-SUBMISSION.md` — fill that in and submit through the LinkedIn dashboard once products are added.

Until App Review approves the `w_member_social` scope for actual posting:
- ✅ `mcp_linkedin_mcp_sanity_ping` (read profile) — works
- ✅ `mcp_linkedin_mcp_get_post` (read our posts) — works
- ❌ `mcp_linkedin_mcp_create_text_post` (write) — returns `403 unauthorized_scope` from LinkedIn

## Quick reference — the scope → product map

| Scope | Required Product | Tier |
|---|---|---|
| `openid` | Sign In with LinkedIn (OIDC) | Standard (auto-granted) |
| `profile` | Sign In with LinkedIn (OIDC) | Standard |
| `email` | Sign In with LinkedIn (OIDC) | Standard |
| `w_member_social` | Share on LinkedIn | Default (auto-granted access) + App Review (for posting) |

Just enabling the two products gets the OAuth dance working end-to-end. App Review is only required if you want the MCP server to actually post on your behalf.

## When both products are enabled

Tell me "products enabled" and I'll re-test the OAuth flow. Expected: LinkedIn consent screen → click Allow → green "LinkedIn connected ✓" page → BWS has the token.