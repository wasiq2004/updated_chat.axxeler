// Facebook / Meta Graph helpers for two features that share one Meta app:
//   1. WhatsApp Embedded Signup — exchange the Business-Login `code` for a token
//      used to connect the customer's WhatsApp Business Account.
//   2. "Sign in with Facebook" — verify a user access token server-side and
//      resolve the person's app-scoped user id, which we match to a linked
//      Z-Chat account.
//
// All credentials come from env (FB_APP_ID / FB_APP_SECRET / FB_LOGIN_CONFIG_ID),
// so the whole feature is inert until an operator configures a Meta app. Nothing
// here ever logs a token or secret.

const FB_APP_ID = () => (process.env.FB_APP_ID || '').trim();
const FB_APP_SECRET = () => (process.env.FB_APP_SECRET || '').trim();
const FB_LOGIN_CONFIG_ID = () => (process.env.FB_LOGIN_CONFIG_ID || '').trim();
const GRAPH_VERSION = () => process.env.META_API_VERSION || 'v21.0';
const GRAPH = () => `https://graph.facebook.com/${GRAPH_VERSION()}`;

// The feature is only usable when at least the (public) app id is configured.
// The code-exchange paths additionally need the secret; callers that require it
// check `canExchange()` and surface a clear error.
function isConfigured() {
  return !!FB_APP_ID();
}
function canExchange() {
  return !!(FB_APP_ID() && FB_APP_SECRET());
}

// Non-secret values safe to hand to the browser so the JS SDK can init.
function getPublicConfig() {
  return {
    enabled: isConfigured(),
    appId: FB_APP_ID() || null,
    configId: FB_LOGIN_CONFIG_ID() || null,
    graphVersion: GRAPH_VERSION(),
  };
}

async function graphGet(path, params = {}) {
  const url = new URL(`${GRAPH()}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url, { method: 'GET' });
  const text = await resp.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  if (!resp.ok) {
    throw new Error(body?.error?.message || text || `Graph HTTP ${resp.status}`);
  }
  return body;
}

/**
 * Exchange a Facebook Business-Login `code` (response_type='code') for an access
 * token, server-to-server. Meta's embedded-signup code flow needs no redirect_uri.
 * Returns the access token string. Throws if not configured or on a Graph error.
 */
async function exchangeCodeForToken(code) {
  if (!code) throw new Error('Missing Facebook code');
  if (!canExchange()) {
    throw new Error('Facebook login is not configured (FB_APP_ID / FB_APP_SECRET missing).');
  }
  const body = await graphGet('oauth/access_token', {
    client_id: FB_APP_ID(),
    client_secret: FB_APP_SECRET(),
    code,
  });
  if (!body.access_token) throw new Error('Facebook did not return an access token');
  return body.access_token;
}

// App access token for calling /debug_token. Using the literal APP_ID|APP_SECRET
// form avoids a network round-trip and never leaves our server.
function appAccessToken() {
  return `${FB_APP_ID()}|${FB_APP_SECRET()}`;
}

/**
 * Verify an access token belongs to OUR app and is valid, returning the token
 * owner's app-scoped Facebook user id. This is the trusted identity used for the
 * "Sign in with Facebook" login path — never trust a client-supplied id.
 * Returns { fbUserId } or throws.
 */
async function verifyTokenOwner(accessToken) {
  if (!accessToken) throw new Error('Missing Facebook access token');
  if (!canExchange()) {
    throw new Error('Facebook login is not configured (FB_APP_ID / FB_APP_SECRET missing).');
  }
  const res = await graphGet('debug_token', {
    input_token: accessToken,
    access_token: appAccessToken(),
  });
  const data = res?.data || {};
  if (!data.is_valid) throw new Error('Facebook token is invalid or expired');
  if (String(data.app_id) !== FB_APP_ID()) {
    throw new Error('Facebook token was issued for a different app');
  }
  const fbUserId = data.user_id ? String(data.user_id) : '';
  if (!fbUserId) throw new Error('Could not resolve a Facebook user id from this token');
  return { fbUserId };
}

/**
 * Best-effort profile fetch (id + name + email) for a verified user token. Used
 * only to enrich account linking; failures are non-fatal to the caller.
 */
async function fetchProfile(accessToken) {
  try {
    const me = await graphGet('me', { fields: 'id,name,email', access_token: accessToken });
    return { fbUserId: me.id ? String(me.id) : null, name: me.name || null, email: me.email || null };
  } catch {
    return { fbUserId: null, name: null, email: null };
  }
}

/**
 * Subscribe our app to the customer's WABA so we receive its webhooks. Required
 * to finish embedded signup, but best-effort here — a failure shouldn't block
 * saving the connected account (an admin can retry in Meta Business Manager).
 */
async function subscribeAppToWaba(wabaId, accessToken) {
  if (!wabaId || !accessToken) return { ok: false, skipped: true };
  try {
    const url = `${GRAPH()}/${encodeURIComponent(wabaId)}/subscribed_apps`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await resp.text();
    let body = {};
    try { body = JSON.parse(text); } catch { /* ignore */ }
    if (!resp.ok) return { ok: false, error: body?.error?.message || `HTTP ${resp.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  isConfigured,
  canExchange,
  getPublicConfig,
  exchangeCodeForToken,
  verifyTokenOwner,
  fetchProfile,
  subscribeAppToWaba,
};
