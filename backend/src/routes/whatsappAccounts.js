const { Router } = require('express');
const pool = require('../db');
const { encrypt, decrypt, maskSecret } = require('../util/crypto');
const { adminOnly, scopeClause, orgScope } = require('../middleware/access');
const { isAdmin } = require('../permissions');
const facebookAuth = require('../services/facebookAuth');

const router = Router();

/**
 * Look up a phone number's human-readable number + verified business name from
 * the Meta Graph API. The simplified connection form no longer asks the user to
 * type these, so we derive them from the Phone Number ID + access token. Also
 * doubles as a credential check. Throws on a non-2xx Meta response.
 */
async function fetchPhoneMeta(phoneNumberId, accessToken) {
  const version = process.env.META_API_VERSION || 'v21.0';
  const apiUrl = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`;
  const resp = await fetch(apiUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await resp.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!resp.ok) {
    throw new Error(body?.error?.message || text || `HTTP ${resp.status}`);
  }
  return body; // { display_phone_number, verified_name, id }
}

// Serialise an account row for the API. Secrets — the masked access token and
// the webhook verify token — are ONLY included for admins (`includeSecrets`).
// The full (decrypted) access token is never sent over the API at all.
function publicShape(row, { includeSecrets = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    displayName: row.display_name,
    displayPhoneNumber: row.display_phone_number,
    phoneNumberId: row.phone_number_id,
    wabaId: row.waba_id,
    metaAppId: row.meta_app_id,
    isDefault: row.is_default,
    isActive: row.is_active,
    healthStatus: row.health_status || 'unknown',
    connectionMethod: row.connection_method || 'manual',
    lastErrorAt: row.last_error_at,
    lastErrorMessage: row.last_error_message,
    lastSuccessAt: row.last_success_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeSecrets) {
    out.accessTokenMasked = maskSecret(decrypt(row.access_token_encrypted));
    out.verifyToken = row.verify_token_encrypted ? decrypt(row.verify_token_encrypted) : '';
  }
  return out;
}

// List all accounts (any authenticated user — needed for template/broadcast pickers)
router.get('/whatsapp-accounts', async (req, res) => {
  try {
    const params = [req.query.activeOnly === 'true' ? true : null];
    const tScope = scopeClause(req, null, params);
    const oScope = orgScope(req, null, params);
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.whatsapp_accounts
        WHERE ($1::boolean IS NULL OR is_active = $1)${tScope}${oScope}
        ORDER BY is_default DESC, display_name ASC`,
      params
    );
    const includeSecrets = isAdmin(req.user);
    res.json(rows.map(r => publicShape(r, { includeSecrets })));
  } catch (err) {
    console.error('[whatsapp-accounts] list error:', err.message);
    res.status(500).json({ error: 'Failed to list WhatsApp Business accounts' });
  }
});

// Resolve account by phone (must be registered before :id so it doesn't match :id=by-phone)
router.get('/whatsapp-accounts/by-phone/:phone', async (req, res) => {
  try {
    const acc = await getAccountByPhoneNumber(req.params.phone);
    if (!acc) return res.status(404).json({ error: 'No WhatsApp Business account registered for this phone' });
    res.json({
      id: acc.id,
      displayName: acc.displayName,
      displayPhoneNumber: acc.displayPhoneNumber,
      phoneNumberId: acc.phoneNumberId,
      wabaId: acc.wabaId,
      isActive: acc.isActive,
    });
  } catch (err) {
    console.error('[whatsapp-accounts] by-phone error:', err.message);
    res.status(500).json({ error: 'Failed to resolve account' });
  }
});

// Get one — admin only; returns the masked token + verify token (never the
// full access token).
router.get('/whatsapp-accounts/:id', adminOnly, async (req, res) => {
  try {
    const idParams = [req.params.id];
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1${scopeClause(req, null, idParams)}`,
      idParams
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(publicShape(rows[0], { includeSecrets: true }));
  } catch (err) {
    console.error('[whatsapp-accounts] get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch WhatsApp Business account' });
  }
});

router.post('/whatsapp-accounts', adminOnly, async (req, res) => {
  try {
    const { phoneNumberId, wabaId, accessToken, verifyToken, metaAppId } = req.body || {};
    if (!phoneNumberId || !wabaId || !accessToken) {
      return res.status(400).json({ error: 'Phone Number ID, WhatsApp Business Account ID and Permanent Access Token are required' });
    }

    // Best-effort: resolve the human-readable number + verified business name
    // from Meta so chat threading and display still work without the user
    // typing them. Saving proceeds even if the lookup fails (logged).
    let displayName = `WhatsApp ${wabaId.trim()}`;
    let displayPhoneNumber = '';
    try {
      const meta = await fetchPhoneMeta(phoneNumberId.trim(), accessToken.trim());
      if (meta.verified_name) displayName = meta.verified_name;
      if (meta.display_phone_number) displayPhoneNumber = String(meta.display_phone_number).replace(/\D/g, '');
    } catch (e) {
      // Don't save a half-working account. The lookup doubles as a credential
      // check, so a failure here means the Phone Number ID + token combination
      // can't talk to Meta (wrong ID, wrong app, or an expired token — a Meta
      // *test number*'s token expires every 24h). Surface Meta's reason.
      console.warn('[whatsapp-accounts] Meta credential check failed:', e.message);
      return res.status(400).json({
        error: `Couldn't verify this WhatsApp number with Meta. Double-check your Phone Number ID and access token (a test number's token expires every 24 hours). Meta said: ${e.message}`,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // First account becomes the default; subsequent accounts are non-default
      // (admin can promote via PATCH later). The partial unique index on
      // (is_default) WHERE is_default = TRUE ensures only one default at a time.
      const { rows } = await client.query(
        `INSERT INTO coexistence.whatsapp_accounts
          (display_name, display_phone_number, phone_number_id, waba_id, meta_app_id,
           access_token_encrypted, verify_token_encrypted, is_default, is_active,
           tenant_id, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
           (SELECT NOT EXISTS (SELECT 1 FROM coexistence.whatsapp_accounts
                                WHERE tenant_id IS NOT DISTINCT FROM $8)),
           TRUE, $8, $9)
         RETURNING *`,
        [
          displayName, displayPhoneNumber, phoneNumberId.trim(), wabaId.trim(),
          metaAppId?.trim() || null,
          encrypt(accessToken.trim()), encrypt((verifyToken || '').trim()),
          req.tenantId ?? null, req.organizationId ?? null,
        ]
      );
      await client.query('COMMIT');
      res.status(201).json(publicShape(rows[0], { includeSecrets: true }));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This Phone Number ID is already connected' });
    console.error('[whatsapp-accounts] create error:', err.message);
    res.status(500).json({ error: 'Failed to create WhatsApp Business account' });
  }
});

// POST /whatsapp-accounts/embedded-signup — connect a WABA via Facebook Business
// Login (Meta Embedded Signup) instead of pasting a token. The browser runs
// FB.login({config_id, response_type:'code'}) and posts the returned `code` plus
// the WABA + Phone IDs captured from the WA_EMBEDDED_SIGNUP message event. We
// exchange the code for a token server-side, verify + save the account, and link
// the person's Facebook identity to their account so they can later sign in with
// Facebook. Optional fbAccessToken lets us capture a server-verified identity.
router.post('/whatsapp-accounts/embedded-signup', adminOnly, async (req, res) => {
  const { code, wabaId, phoneNumberId, metaAppId, fbAccessToken, fbUserId } = req.body || {};
  if (!facebookAuth.isConfigured()) {
    return res.status(400).json({ error: 'Facebook login is not enabled on this server.' });
  }
  if (!code || !wabaId || !phoneNumberId) {
    return res.status(400).json({ error: 'Facebook code, WhatsApp Business Account ID and Phone Number ID are required' });
  }
  try {
    // 1. Exchange the Business-Login code for an access token (server-to-server).
    const accessToken = await facebookAuth.exchangeCodeForToken(code);

    // 2. Verify the token can talk to Meta for this number + derive display name.
    let displayName = `WhatsApp ${String(wabaId).trim()}`;
    let displayPhoneNumber = '';
    try {
      const meta = await fetchPhoneMeta(String(phoneNumberId).trim(), accessToken);
      if (meta.verified_name) displayName = meta.verified_name;
      if (meta.display_phone_number) displayPhoneNumber = String(meta.display_phone_number).replace(/\D/g, '');
    } catch (e) {
      console.warn('[whatsapp-accounts] embedded-signup Meta check failed:', e.message);
      return res.status(400).json({ error: `Couldn't verify this WhatsApp number with Meta: ${e.message}` });
    }

    // 3. Subscribe our app to the WABA so its webhooks reach us (best-effort).
    const sub = await facebookAuth.subscribeAppToWaba(String(wabaId).trim(), accessToken);
    if (!sub.ok && !sub.skipped) {
      console.warn('[whatsapp-accounts] subscribed_apps failed (continuing):', sub.error);
    }

    // 4. Register the number with the Cloud API — Meta's REQUIRED final step of
    //    Embedded Signup. Skip it and the number is connected but cannot send a
    //    single message.
    //
    //    Best-effort on purpose: a registration failure must not throw away a
    //    working token + connection. We record the outcome instead and surface it,
    //    so the UI can say "connected, but not sendable yet" rather than lying.
    //    The most common failure is 133005 — the number already carries a
    //    two-step PIN from a previous setup that we cannot know.
    const pin = facebookAuth.generateTwoStepPin();
    const reg = await facebookAuth.registerPhoneNumber(String(phoneNumberId).trim(), accessToken, pin);
    if (!reg.ok) {
      console.warn(`[whatsapp-accounts] /register failed (continuing): ${reg.error} (code ${reg.code ?? '—'})`);
    }

    // 5. Persist the connected account (mirrors the manual create INSERT).
    const client = await pool.connect();
    let created;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO coexistence.whatsapp_accounts
          (display_name, display_phone_number, phone_number_id, waba_id, meta_app_id,
           access_token_encrypted, verify_token_encrypted, is_default, is_active,
           connection_method, tenant_id, organization_id,
           two_step_pin_encrypted, registered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
           (SELECT NOT EXISTS (SELECT 1 FROM coexistence.whatsapp_accounts
                                WHERE tenant_id IS NOT DISTINCT FROM $8)),
           TRUE, 'embedded_signup', $8, $9, $10, $11)
         RETURNING *`,
        [
          displayName, displayPhoneNumber, String(phoneNumberId).trim(), String(wabaId).trim(),
          metaAppId?.trim() || facebookAuth.getPublicConfig().appId || null,
          encrypt(accessToken), encrypt(''),
          req.tenantId ?? null, req.organizationId ?? null,
          // Only store the PIN if Meta actually accepted it. Storing one it
          // rejected would be a lie we'd later act on during re-registration.
          reg.ok ? encrypt(pin) : null,
          reg.ok ? new Date() : null,
        ]
      );
      await client.query('COMMIT');
      created = rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // 6. Link the person's Facebook identity to their account so "Sign in with
    //    Facebook" works next time. Prefer a server-verified id (from a user
    //    token); fall back to the client-asserted id. Best-effort — a linking
    //    failure (e.g. the id already belongs to another account) must not fail
    //    the connection itself.
    let linkedFbUserId = null;
    try {
      if (fbAccessToken) {
        const owner = await facebookAuth.verifyTokenOwner(fbAccessToken);
        linkedFbUserId = owner.fbUserId;
      } else if (fbUserId) {
        linkedFbUserId = String(fbUserId);
      }
      if (linkedFbUserId) {
        await pool.query(
          `UPDATE coexistence.z_chat_users
              SET fb_user_id = $1
            WHERE id = $2 AND (fb_user_id IS NULL OR fb_user_id = $1)`,
          [linkedFbUserId, req.user.id]
        );
      }
    } catch (e) {
      if (e.code === '23505') {
        console.warn('[whatsapp-accounts] Facebook id already linked to another account; skipping link.');
      } else {
        console.warn('[whatsapp-accounts] Facebook identity link failed (continuing):', e.message);
      }
    }

    res.status(201).json({
      ...publicShape(created, { includeSecrets: true }),
      fbLinked: !!linkedFbUserId,
      // The account row exists either way, so the client must be told whether the
      // number can actually SEND — otherwise the first broadcast fails with a
      // baffling Meta error and nobody connects it back to this step.
      registered: !!reg.ok,
      registrationError: reg.ok ? null : (reg.error || 'Registration failed'),
      registrationCode: reg.ok ? null : (reg.code ?? null),
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This Phone Number ID is already connected' });
    console.error('[whatsapp-accounts] embedded-signup error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to connect WhatsApp via Facebook' });
  }
});

router.put('/whatsapp-accounts/:id', adminOnly, async (req, res) => {
  try {
    const { phoneNumberId, wabaId, accessToken, verifyToken, metaAppId, isActive } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const exParams = [req.params.id];
      const { rows: existingRows } = await client.query(
        `SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1${scopeClause(req, null, exParams)}`, exParams
      );
      if (existingRows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Not found' });
      }
      const ex = existingRows[0];

      const newPhoneId = phoneNumberId != null ? phoneNumberId.trim() : ex.phone_number_id;
      const newWaba = wabaId != null ? wabaId.trim() : ex.waba_id;
      const tokenChanged = !!(accessToken && accessToken.trim());
      const effectiveToken = tokenChanged ? accessToken.trim() : decrypt(ex.access_token_encrypted);

      // Re-derive the display fields from Meta when the number or token changes.
      let displayName = ex.display_name;
      let displayPhoneNumber = ex.display_phone_number;
      if ((phoneNumberId != null && newPhoneId !== ex.phone_number_id) || tokenChanged) {
        try {
          const meta = await fetchPhoneMeta(newPhoneId, effectiveToken);
          if (meta.verified_name) displayName = meta.verified_name;
          if (meta.display_phone_number) displayPhoneNumber = String(meta.display_phone_number).replace(/\D/g, '');
        } catch (e) {
          // Same credential check as on connect: if the changed number/token
          // can't reach Meta, refuse the update and tell the user why instead
          // of silently keeping stale values.
          console.warn('[whatsapp-accounts] Meta credential check failed on update:', e.message);
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Couldn't verify this WhatsApp number with Meta. Double-check your Phone Number ID and access token (a test number's token expires every 24 hours). Meta said: ${e.message}`,
          });
        }
      }

      const sets = ['updated_at = NOW()'];
      const params = [];
      let i = 1;
      const push = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };
      push('display_name', displayName);
      push('display_phone_number', displayPhoneNumber);
      push('phone_number_id', newPhoneId);
      push('waba_id', newWaba);
      if (metaAppId !== undefined) push('meta_app_id', metaAppId?.trim() || null);
      if (tokenChanged) {
        push('access_token_encrypted', encrypt(effectiveToken));
        // Reset health on token update so the UI banner clears.
        push('health_status', 'unknown');
        push('last_error_message', null);
      }
      if (verifyToken !== undefined) push('verify_token_encrypted', encrypt((verifyToken || '').trim()));
      if (isActive != null) push('is_active', !!isActive);
      params.push(req.params.id);
      const { rows } = await client.query(
        `UPDATE coexistence.whatsapp_accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        params
      );
      await client.query('COMMIT');
      res.json(publicShape(rows[0], { includeSecrets: true }));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'This Phone Number ID is already connected' });
    console.error('[whatsapp-accounts] update error:', err.message);
    res.status(500).json({ error: 'Failed to update WhatsApp Business account' });
  }
});

router.delete('/whatsapp-accounts/:id', adminOnly, async (req, res) => {
  try {
    const delParams = [req.params.id];
    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.whatsapp_accounts WHERE id = $1${scopeClause(req, null, delParams)}`,
      delParams
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[whatsapp-accounts] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete WhatsApp Business account' });
  }
});

// Normalise phone numbers for matching: strip everything but digits.
function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

function rowToCreds(r) {
  if (!r) return null;
  return {
    id: r.id,
    displayName: r.display_name,
    displayPhoneNumber: r.display_phone_number,
    phoneNumberId: r.phone_number_id,
    wabaId: r.waba_id,
    accessToken: decrypt(r.access_token_encrypted),
    isActive: r.is_active,
  };
}

async function getAccountWithToken(accountId) {
  const { rows } = await pool.query(
    'SELECT * FROM coexistence.whatsapp_accounts WHERE id = $1',
    [accountId]
  );
  return rowToCreds(rows[0]);
}

/**
 * Return the single connected account (this product is capped at one). Used as
 * a fallback when phone-number matching can't resolve an account — e.g. the
 * display number hasn't been derived from Meta yet.
 */
async function getSingleAccount() {
  const { rows } = await pool.query(
    'SELECT * FROM coexistence.whatsapp_accounts ORDER BY is_default DESC, id ASC LIMIT 1'
  );
  return rowToCreds(rows[0]);
}

/**
 * Resolve the WhatsApp account that owns the given phone number. Used by
 * broadcasts and automation message nodes to derive credentials from a
 * "from" phone number. Matches by digits-only normalisation so users can
 * register the number as "+919342245724" or "919342245724".
 */
async function getAccountByPhoneNumber(phoneOrId) {
  const norm = normalizePhone(phoneOrId);
  if (!norm) return null;
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.whatsapp_accounts
       WHERE regexp_replace(display_phone_number, '\\D', '', 'g') = $1
          OR phone_number_id = $2
       LIMIT 1`,
    [norm, String(phoneOrId)]
  );
  return rowToCreds(rows[0]);
}

module.exports = { router, getAccountWithToken, getAccountByPhoneNumber, getSingleAccount };
