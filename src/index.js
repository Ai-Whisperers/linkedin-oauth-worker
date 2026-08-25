/**
 * linkedin-oauth — Cloudflare Worker implementing the OAuth 2.0 authorization
 * code flow for the Hermes LinkedIn integration.
 *
 * Endpoints:
 *   GET  /auth/linkedin/start      → 302 to LinkedIn authorize URL (with state cookie)
 *   GET  /auth/linkedin/callback   → exchanges code, writes token to BWS, returns success HTML
 *   POST /auth/linkedin/refresh    → exchanges refresh_token for a new access_token
 *   GET  /healthz                  → 200 "ok"
 *
 * Secrets required (set with `wrangler secret put`):
 *   LINKEDIN_CLIENT_ID
 *   LINKEDIN_CLIENT_SECRET
 *   LINKEDIN_REDIRECT_URI              e.g. https://hermes.paragu-ai.com/auth/linkedin/callback
 *   LINKEDIN_SCOPES                    space-separated, default "openid profile email w_member_social"
 *   BWS_ACCESS_TOKEN                   Bitwarden Secrets Manager service-account token
 *   BWS_BASE_URL                       default https://vault.bitwarden.com/api
 *   BWS_SECRET_ID_ACCESS_TOKEN         UUID of the LINKEDIN_ACCESS_TOKEN secret
 *   BWS_SECRET_ID_ISSUED_AT            UUID of the LINKEDIN_TOKEN_ISSUED_AT secret
 *   BWS_SECRET_ID_SCOPES               UUID of the LINKEDIN_TOKEN_SCOPES secret
 *   BWS_SECRET_ID_REFRESH_TOKEN        UUID of the LINKEDIN_REFRESH_TOKEN secret (optional)
 *
 * Trademark note: this Worker is named `linkedin-oauth` per the org banlist
 * carve-outs. Do not rename to anything containing upstream product names.
 */

// ----- BWS client (minimal REST wrapper) -----
async function bwsPutSecret(baseUrl, bwsToken, secretId, value) {
  const r = await fetch(`${baseUrl}/secrets/${secretId}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${bwsToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ value }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`BWS PUT failed ${r.status}: ${t.slice(0, 200)}`);
  }
  return await r.json();
}

// ----- State store (10-min TTL via KV) -----
async function saveState(kv, state) {
  await kv.put("state:" + state, "1", { expirationTtl: 600 });
}
async function consumeState(kv, state) {
  if (!state) return false;
  const v = await kv.get("state:" + state);
  if (!v) return false;
  await kv.delete("state:" + state);
  return true;
}

function htmlResponse(status, body) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function randomState() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ----- LinkedIn OAuth helpers -----
async function exchangeCodeForToken(env, code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.LINKEDIN_REDIRECT_URI,
    client_id: env.LINKEDIN_CLIENT_ID,
    client_secret: env.LINKEDIN_CLIENT_SECRET,
  });
  const r = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`LinkedIn token exchange failed ${r.status}: ${t.slice(0, 300)}`);
  }
  return await r.json();
}

async function refreshToken(env, refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.LINKEDIN_CLIENT_ID,
    client_secret: env.LINKEDIN_CLIENT_SECRET,
  });
  const r = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`LinkedIn token refresh failed ${r.status}: ${t.slice(0, 300)}`);
  }
  return await r.json();
}

// ----- Handlers -----
async function handleStart(env, request) {
  const state = randomState();
  await saveState(env.OAUTH_STATE, state);
  const scopes = env.LINKEDIN_SCOPES || "openid profile email w_member_social";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.LINKEDIN_CLIENT_ID,
    redirect_uri: env.LINKEDIN_REDIRECT_URI,
    state,
    scope: scopes,
  });
  return redirect("https://www.linkedin.com/oauth/v2/authorization?" + params.toString());
}

async function handleCallback(env, request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return htmlResponse(400, `<h1>LinkedIn denied</h1><p>${error}: ${url.searchParams.get("error_description") ?? ""}</p>`);
  }
  if (!code || !state) {
    return htmlResponse(400, "<h1>Missing code or state</h1>");
  }
  const ok = await consumeState(env.OAUTH_STATE, state);
  if (!ok) {
    return htmlResponse(400, "<h1>Invalid or expired state. Try <a href='/auth/linkedin/start'>connecting again</a>.</h1>");
  }

  let token;
  try {
    token = await exchangeCodeForToken(env, code);
  } catch (e) {
    return htmlResponse(502, `<h1>Token exchange failed</h1><pre>${String(e).slice(0, 500)}</pre>`);
  }

  const issuedAt = new Date().toISOString();
  const expiresInDays = token.expires_in ? Math.round(token.expires_in / 86400) : 60;

  // Write all 3 (or 4) secrets to BWS
  const baseUrl = env.BWS_BASE_URL || "https://vault.bitwarden.com/api";
  const writes = [
    bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_ACCESS_TOKEN, token.access_token),
    bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_ISSUED_AT, issuedAt),
    bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_SCOPES, token.scope || ""),
  ];
  if (token.refresh_token && env.BWS_SECRET_ID_REFRESH_TOKEN) {
    writes.push(bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_REFRESH_TOKEN, token.refresh_token));
  }

  let writeErrors = [];
  await Promise.all(writes.map((p) => p.catch((e) => writeErrors.push(String(e).slice(0, 200)))));

  if (writeErrors.length === writes.length) {
    return htmlResponse(502, `<h1>LinkedIn authorized but BWS writes failed</h1><pre>${writeErrors.join("\n")}</pre>`);
  }

  return htmlResponse(
    200,
    `<!doctype html><html><head><title>LinkedIn connected</title></head><body>
     <h1>LinkedIn connected ✓</h1>
     <p>Token expires in <b>${expiresInDays} days</b>. Issued at ${issuedAt}.</p>
     <p>Scopes: <code>${token.scope || "(unknown)"}</code></p>
     ${writeErrors.length ? `<p style="color:#c80">⚠️ ${writeErrors.length} of ${writes.length} secret writes failed — check logs.</p>` : ""}
     <p>You can close this tab.</p>
     </body></html>`
  );
}

async function handleRefresh(env, request) {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  let refreshTokenValue;
  try {
    const body = await request.json();
    refreshTokenValue = body.refresh_token;
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  if (!refreshTokenValue) return new Response("missing refresh_token", { status: 400 });

  let token;
  try {
    token = await refreshToken(env, refreshTokenValue);
  } catch (e) {
    return new Response(String(e).slice(0, 500), { status: 502 });
  }

  const issuedAt = new Date().toISOString();
  const baseUrl = env.BWS_BASE_URL || "https://vault.bitwarden.com/api";
  await Promise.all([
    bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_ACCESS_TOKEN, token.access_token),
    bwsPutSecret(baseUrl, env.BWS_ACCESS_TOKEN, env.BWS_SECRET_ID_ISSUED_AT, issuedAt),
  ]);

  return Response.json({ ok: true, expires_in: token.expires_in, issued_at: issuedAt });
}

// ----- Router -----
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/auth/linkedin/start") return await handleStart(env, request);
      if (url.pathname === "/auth/linkedin/callback") return await handleCallback(env, request);
      if (url.pathname === "/auth/linkedin/refresh") return await handleRefresh(env, request);
      if (url.pathname === "/healthz") return new Response("ok", { status: 200 });
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response("server error: " + String(e).slice(0, 500), { status: 500 });
    }
  },
};