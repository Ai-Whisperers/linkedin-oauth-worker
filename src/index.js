/**
 * linkedin-oauth — CF Worker. Hermes Hermes MCP integration.
 *
 * OAuth 2.0 authorization code flow for LinkedIn.
 *
 * Writes the access token to CF KV namespace `OAUTH_STATE` (key prefix `linkedin:`).
 * A separate cron in the hermes container (kv_bws_sync.py) bridges CF KV → BWS via the SDK.
 *
 * Why CF KV instead of BWS directly: BWS machine-account tokens only support SDK-based writes
 * (not REST PUT). CF Workers can't load the SDK. So we write to CF KV (Worker-native) and sync.
 *
 * Endpoints:
 *   GET  /auth/linkedin/start      → 302 to LinkedIn authorize URL
 *   GET  /auth/linkedin/callback   → exchanges code → stores to CF KV → green success page
 *   POST /auth/linkedin/refresh    → exchanges refresh_token → updates KV
 *   GET  /healthz                  → liveness probe
 *
 * Secrets (set via `wrangler secret put`):
 *   LINKEDIN_CLIENT_ID
 *   LINKEDIN_CLIENT_SECRET
 *   LINKEDIN_REDIRECT_URI
 *   LINKEDIN_SCOPES       (space-separated)
 */

// ----- CSRF state (CF KV) -----
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

// ----- Writeback helper (CF KV) -----
async function kvPut(kv, key, value, ttlSeconds) {
  const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
  await kv.put(key, value, opts);
}

// ----- HTTP helpers -----
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

// ----- LinkedIn API -----
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

async function refreshLongLivedToken(env, refreshToken) {
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
    throw new Error(`LinkedIn refresh failed ${r.status}: ${t.slice(0, 300)}`);
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
    if (!token.access_token) {
      throw new Error("Token missing access_token field: " + JSON.stringify(token));
    }
  } catch (e) {
    return htmlResponse(502, `<h1>Token exchange failed</h1><pre>${String(e).slice(0, 500)}</pre>`);
  }

  const issuedAt = new Date().toISOString();
  const expiresInDays = token.expires_in ? Math.round(token.expires_in / 86400) : 60;

  // Write all token fields to CF KV (key prefix "linkedin:") for the kv-bws-sync cron to pick up.
  // KV entries use 90-day TTL — covers the 60-day token lifetime with buffer.
  try {
    await kvPut(env.OAUTH_STATE, "linkedin:access_token", token.access_token, 90 * 86400);
    await kvPut(env.OAUTH_STATE, "linkedin:issued_at", issuedAt, 90 * 86400);
    await kvPut(env.OAUTH_STATE, "linkedin:scopes", env.LINKEDIN_SCOPES || "", 90 * 86400);
    if (token.refresh_token) {
      await kvPut(env.OAUTH_STATE, "linkedin:refresh_token", token.refresh_token, 90 * 86400);
    }
  } catch (e) {
    return htmlResponse(502, `<h1>CF KV writeback failed</h1><pre>${String(e).slice(0, 500)}</pre>`);
  }

  return htmlResponse(
    200,
    `<!doctype html><html><head><title>LinkedIn connected</title></head><body>
     <h1>LinkedIn connected ✓</h1>
     <p>Token expires in <b>${expiresInDays} days</b>. Issued at ${issuedAt}.</p>
     <p>Scopes: <code>${env.LINKEDIN_SCOPES || "(unknown)"}</code></p>
     <p>Token written to CF KV (kv-bws-sync will move it to BWS within 5 min).</p>
     <p>You can close this tab.</p>
     </body></html>`
  );
}

async function handleRefresh(env, request) {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  let refreshToken;
  try {
    const body = await request.json();
    refreshToken = body.refresh_token;
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  if (!refreshToken) return new Response("missing refresh_token", { status: 400 });

  let token;
  try {
    token = await refreshLongLivedToken(env, refreshToken);
  } catch (e) {
    return new Response(String(e).slice(0, 500), { status: 502 });
  }

  const issuedAt = new Date().toISOString();
  try {
    await kvPut(env.OAUTH_STATE, "linkedin:access_token", token.access_token, 90 * 86400);
    await kvPut(env.OAUTH_STATE, "linkedin:issued_at", issuedAt, 90 * 86400);
    if (token.refresh_token) {
      await kvPut(env.OAUTH_STATE, "linkedin:refresh_token", token.refresh_token, 90 * 86400);
    }
  } catch (e) {
    return new Response("CF KV writeback failed: " + String(e).slice(0, 300), { status: 502 });
  }

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