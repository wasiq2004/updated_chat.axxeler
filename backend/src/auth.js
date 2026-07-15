const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { effectivePages } = require('./permissions');
const { isStrong } = require('./util/instanceSecrets');
const facebookAuth = require('./services/facebookAuth');
const { createWorkspace, emailTaken } = require('./services/signup');
const verification = require('./services/emailVerification');
const { auditLog } = require('./middleware/access');

async function loadUserSession(userId) {
  const { rows } = await pool.query(
    `SELECT id, username, email, display_name, role, permissions, is_active, last_login_at, tenant_id, reseller_id
       FROM coexistence.z_chat_users WHERE id = $1`,
    [userId]
  );
  const u = rows[0];
  if (!u) return null;
  const { rows: waRows } = await pool.query(
    `SELECT wa_number FROM coexistence.user_wa_assignments WHERE user_id = $1`,
    [userId]
  );
  // SaaS: surface whether this is a platform super admin (full platform owner) or
  // a white-label reseller admin (scoped partner) so the UI shows the right
  // console. Tolerate the RBAC tables not existing yet (pre-migration).
  let isSuperAdmin = false;
  let isResellerAdmin = false;
  try {
    const { rows: roleRows } = await pool.query(
      `SELECT r.key FROM coexistence.user_roles ur
         JOIN coexistence.roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND r.key IN ('super_admin', 'reseller_admin')`,
      [userId]
    );
    const keys = new Set(roleRows.map(r => r.key));
    isSuperAdmin = keys.has('super_admin');
    isResellerAdmin = keys.has('reseller_admin');
  } catch { /* RBAC tables not migrated yet — treat as non-privileged */ }
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    isActive: u.is_active,
    permissions: u.permissions || null,
    pages: Array.from(effectivePages({ role: u.role, permissions: u.permissions })),
    assignedWaNumbers: waRows.map(r => r.wa_number),
    tenantId: u.tenant_id ?? null,
    resellerId: u.reseller_id ?? null,
    isSuperAdmin,
    isResellerAdmin,
  };
}

// JWT_SECRET is guaranteed present + strong by util/instanceSecrets, which runs
// first in index.js (resolves from env, else a persisted file, else generates
// one). The fallback below only matters for non-standard entry points.
const JWT_SECRET = process.env.JWT_SECRET || 'z-chat-dev-secret-change-me';
// Defence-in-depth: in production, refuse to boot if JWT_SECRET wasn't resolved
// to a strong value. In normal operation util/instanceSecrets.bootstrapSecrets()
// runs first in index.js and guarantees a strong secret, so this never fires —
// it only catches a misconfigured prod boot (no bootstrap, or a weak/placeholder
// value) instead of silently signing sessions with the well-known dev fallback.
// Inert outside production (dev / `node --test`), where the fallback is fine.
if (process.env.NODE_ENV === 'production' && !isStrong(JWT_SECRET)) {
  throw new Error(
    '[auth] JWT_SECRET is missing or too weak for production. Provide a strong ' +
    'JWT_SECRET (>= 32 chars) or start the app via src/index.js so one is auto-generated.'
  );
}
const COOKIE_NAME = 'z_chat_token';
const TOKEN_EXPIRY = '24h';

const router = Router();

// May this account sign in, verification-wise? Only self-serve signups are ever
// gated, and only while a mailer exists to send the link:
//   * operator-provisioned accounts ('invite') are vouched for by the operator;
//   * every pre-existing account was backfilled as verified by migration 074;
//   * with no SMTP configured, signup verifies on creation (see
//     services/emailVerification) — so this stays false there too.
// Tolerates the column being absent (pre-migration boot): undefined -> verified.
function isVerified(user) {
  if (!verification.verificationRequired()) return true;
  if (user.signup_source && user.signup_source !== 'self_serve') return true;
  if (user.email_verified_at === undefined) return true;
  return user.email_verified_at != null;
}

// Account creation is the most abusable public surface here: it writes a tenant,
// an org, a user and a subscription, and sends mail. The global limiter
// (600/min) is nowhere near tight enough, so signup gets its own IP bucket.
// No custom keyGenerator on purpose: the default already buckets by IP AND
// normalises IPv6 (a bare `req.ip` key lets an IPv6 client mint a fresh bucket
// per address from their /64 and walk straight through the cap —
// express-rate-limit flags this as ERR_ERL_KEY_GEN_IPV6).
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    error: 'Too many signup attempts from this network. Please try again later.',
  }),
});

// Ensure tables exist on startup
async function ensureTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS coexistence.z_chat_users (
        id         BIGSERIAL PRIMARY KEY,
        username   TEXT NOT NULL UNIQUE,
        email      TEXT NOT NULL UNIQUE,
        password   TEXT NOT NULL,
        display_name TEXT,
        role       TEXT NOT NULL DEFAULT 'viewer',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // First admin: when the users table is empty, only seed non-interactively if
    // ADMIN_PASSWORD is provided (headless/CI installs). Otherwise leave the
    // table empty so the first-run UI setup wizard (GET /auth/status ->
    // setupRequired, POST /auth/setup) creates the admin in the browser. No
    // password is ever generated or written to disk.
    const { rows } = await client.query('SELECT COUNT(*) FROM coexistence.z_chat_users');
    if (parseInt(rows[0].count, 10) === 0) {
      if (process.env.ADMIN_PASSWORD) {
        const adminEmail = (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
        await client.query(
          `INSERT INTO coexistence.z_chat_users (username, email, password, display_name, role)
           VALUES ('admin', $1, $2, 'Admin', 'admin')`,
          [adminEmail, hash]
        );
        console.log(`[auth] Seeded admin '${adminEmail}' from ADMIN_PASSWORD.`);
      } else {
        console.log('[auth] No users yet — the first-run setup wizard will create the admin account in the UI.');
      }
    }
  } finally {
    client.release();
  }
}

// Sign a session JWT. `extraClaims` lets callers add fields (e.g. an `imp`
// impersonation marker); `expiresIn` defaults to the standard 24h.
function signToken(user, extraClaims = {}, expiresIn = TOKEN_EXPIRY) {
  return jwt.sign(
    { id: user.id, username: user.username, displayName: user.display_name, role: user.role, ...extraClaims },
    JWT_SECRET,
    { expiresIn }
  );
}

// Set the session cookie with the app's standard options (one place so login and
// impersonation stay identical). maxAgeMs defaults to 24h.
function setAuthCookie(res, token, maxAgeMs = 24 * 60 * 60 * 1000) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: maxAgeMs,
  });
}

async function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  // Legacy tokens (issued by the single-user build) carry no role. Force a
  // clean re-login so every session has a role for permission checks.
  if (!payload.role) {
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
  try {
    // Re-check the live account on every request so a deactivated or demoted
    // user loses access immediately, instead of keeping their old privileges
    // until the 24h token expires. The fresh role also overrides any stale role
    // embedded in the JWT (an admin who demotes a user takes effect at once).
    const { rows } = await pool.query(
      'SELECT role, is_active FROM coexistence.z_chat_users WHERE id = $1',
      [payload.id]
    );
    const u = rows[0];
    if (!u) {
      res.clearCookie(COOKIE_NAME);
      return res.status(401).json({ error: 'User not found' });
    }
    if (u.is_active === false) {
      res.clearCookie(COOKIE_NAME);
      return res.status(403).json({ error: 'Account disabled' });
    }
    req.user = { ...payload, role: u.role };
    next();
  } catch (err) {
    console.error('[auth] authMiddleware account check failed:', err.message);
    res.status(500).json({ error: 'Authentication check failed' });
  }
}

// POST /api/auth/login
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT * FROM coexistence.z_chat_users WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account is disabled. Contact an administrator.' });
    }
    if (!isVerified(user)) {
      return res.status(403).json({
        error: 'Please confirm your email address first. Check your inbox for the link.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }
    const token = signToken(user);
    setAuthCookie(res, token);
    // Best-effort: stamp last_login_at; don't fail login if this errors.
    pool.query(`UPDATE coexistence.z_chat_users SET last_login_at = NOW() WHERE id = $1`, [user.id]).catch(() => {});
    const session = await loadUserSession(user.id);
    res.json({ user: session });
  } catch (err) {
    console.error('[auth] login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/facebook — public. Direct "Sign in with Facebook" for a
// returning user who previously linked their Facebook identity (by connecting
// WhatsApp via Embedded Signup). Body: { accessToken } — a Facebook user access
// token from the browser SDK. We verify it server-side (never trust a client-
// supplied id), resolve the app-scoped user id, and match a linked account. A
// person with no linked account is told to sign in with email/password first.
router.post('/auth/facebook', async (req, res) => {
  if (!facebookAuth.isConfigured()) {
    return res.status(400).json({ error: 'Facebook login is not enabled on this server.' });
  }
  const { accessToken } = req.body || {};
  if (!accessToken) return res.status(400).json({ error: 'Facebook access token required' });
  try {
    const { fbUserId } = await facebookAuth.verifyTokenOwner(accessToken);
    const { rows } = await pool.query(
      'SELECT * FROM coexistence.z_chat_users WHERE fb_user_id = $1',
      [fbUserId]
    );
    const user = rows[0];
    if (!user) return signUpWithFacebook(req, res, { fbUserId, accessToken });
    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account is disabled. Contact an administrator.' });
    }
    const token = signToken(user);
    setAuthCookie(res, token);
    pool.query(`UPDATE coexistence.z_chat_users SET last_login_at = NOW() WHERE id = $1`, [user.id]).catch(() => {});
    const session = await loadUserSession(user.id);
    res.json({ user: session });
  } catch (err) {
    console.error('[auth] facebook login error:', err.message);
    // The signup branch answers for itself (including its own failures); only
    // speak here if nothing has been sent, or Express logs a double-send.
    if (!res.headersSent) {
      res.status(401).json({ error: 'Facebook sign-in failed. Please try again or use email and password.' });
    }
  }
});

// An unrecognised Facebook identity creates a workspace, the same as an email
// signup. Called only from POST /auth/facebook, after the token has been
// verified server-side — never trust a client-supplied Facebook id.
async function signUpWithFacebook(req, res, { fbUserId, accessToken }) {
  const profile = await facebookAuth.fetchProfile(accessToken);
  const email = String(profile.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({
      error: 'Facebook didn’t share an email address with us, so we can’t create your account. Please sign up with your email instead.',
      code: 'FB_NO_EMAIL',
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (await emailTaken(client, email)) {
      await client.query('ROLLBACK');
      // Deliberately NOT auto-linking to the existing account. Adopting an
      // account because Facebook asserts the same address is an account-takeover
      // path; linking stays an authenticated action (connect WhatsApp while
      // signed in), which is how fb_user_id gets set today.
      return res.status(409).json({
        error: 'An account already uses this email. Sign in with your password, then connect Facebook from inside the app.',
        code: 'FB_EMAIL_TAKEN',
      });
    }
    const ws = await createWorkspace(client, {
      email,
      password: null,                    // Facebook is the credential
      displayName: profile.name,
      companyName: req.body?.companyName,
      partnerSlug: req.body?.partnerSlug || null,
      fbUserId,
      source: 'facebook',
    });
    // No verification link: Facebook already vouches for the address, and the
    // person is standing right here having just authenticated with Meta.
    await client.query(
      'UPDATE coexistence.z_chat_users SET email_verified_at = NOW() WHERE id = $1',
      [ws.userId]
    );
    await client.query('COMMIT');

    auditLog({
      actor: { id: ws.userId, username: ws.username },
      action: 'tenant.signup',
      targetType: 'tenant',
      targetId: ws.tenantId,
      payload: { source: 'facebook', resellerId: ws.resellerId },
      tenantId: ws.tenantId,
      from: req,
    });

    setAuthCookie(res, signToken({ id: ws.userId, username: ws.username, display_name: profile.name, role: 'admin' }));
    const session = await loadUserSession(ws.userId);
    return res.status(201).json({ user: session, created: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[auth] facebook signup error:', err.message);
    return res.status(500).json({ error: 'Could not create your account. Please try again.' });
  } finally {
    client.release();
  }
}

// GET /api/auth/me
router.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const session = await loadUserSession(req.user.id);
    if (!session) {
      res.clearCookie(COOKIE_NAME);
      return res.status(401).json({ error: 'User not found' });
    }
    if (session.isActive === false) {
      res.clearCookie(COOKIE_NAME);
      return res.status(403).json({ error: 'Account disabled' });
    }
    // Surface an active impersonation so the UI can show the warning banner.
    if (req.user?.imp) {
      session.impersonation = { by: req.user.imp.byName || 'Super Admin', sessionId: req.user.imp.sessionId };
    }
    res.json({ user: session });
  } catch (err) {
    console.error('[auth] me error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// POST /api/auth/logout
router.post('/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// GET /api/auth/status — public. Tells the frontend whether to show the
// first-run setup wizard (no users yet) instead of the login screen.
router.get('/auth/status', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM coexistence.z_chat_users');
    res.json({ setupRequired: rows[0].n === 0 });
  } catch (err) {
    // DB not ready / not migrated yet — let the UI retry.
    res.status(503).json({ error: 'Service starting' });
  }
});

// POST /api/auth/setup — public, ONE-TIME. Creates the first admin only while
// the users table is empty, then issues the auth cookie. Returns 409 once an
// account exists. A transaction-scoped advisory lock serializes concurrent
// setup attempts so exactly one admin is created.
router.post('/auth/setup', async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(947218531)');
    const { rows: cnt } = await client.query('SELECT COUNT(*)::int AS n FROM coexistence.z_chat_users');
    if (cnt[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Setup already completed' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows: ins } = await client.query(
      `INSERT INTO coexistence.z_chat_users (username, email, password, display_name, role)
       VALUES ('admin', $1, $2, $3, 'admin')
       RETURNING id, username, display_name, role`,
      [email.trim().toLowerCase(), hash, (displayName || 'Admin').trim()]
    );
    await client.query('COMMIT');
    const token = signToken(ins[0]);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000,
    });
    const session = await loadUserSession(ins[0].id);
    res.status(201).json({ user: session });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (err && err.code === '23505') {
      // Unique violation (email/username) — treat as already set up.
      return res.status(409).json({ error: 'Setup already completed' });
    }
    console.error('[auth] setup error:', err.message);
    res.status(500).json({ error: 'Setup failed' });
  } finally {
    client.release();
  }
});

// POST /api/auth/signup — public. Self-serve workspace creation.
// Body: { email, password, displayName, companyName, partnerSlug? }
// `partnerSlug` is the ?w=<slug> the visitor arrived with: it attributes the new
// tenant to that partner, so the customer shows up in the partner's console and
// gets the partner's plan catalog. An unknown slug degrades to platform-direct.
router.post('/auth/signup', signupLimiter, async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  // The very first account must go through the setup wizard, which mints the
  // instance owner. Letting signup win that race would leave the install with no
  // super admin.
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM coexistence.z_chat_users');
    if (rows[0].n === 0) return res.status(409).json({ error: 'This instance is not set up yet.' });
  } catch {
    return res.status(503).json({ error: 'Service starting' });
  }

  // Up to 3 attempts: username/tenant-slug are globally unique and derived, so a
  // concurrent signup can lose a race. A duplicate EMAIL is checked first and
  // returns 409 without retrying — that is a real conflict, not a race.
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (await emailTaken(client, email)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'An account with this email already exists. Try signing in.' });
      }
      const ws = await createWorkspace(client, {
        email,
        password,
        displayName: b.displayName,
        companyName: b.companyName,
        partnerSlug: b.partnerSlug || null,
        source: 'self_serve',
      });
      const mustVerify = verification.verificationRequired();
      const rawToken = mustVerify ? await verification.issueToken(client, ws.userId) : null;
      if (!mustVerify) {
        await client.query(
          `UPDATE coexistence.z_chat_users SET email_verified_at = NOW() WHERE id = $1`,
          [ws.userId]
        );
      }
      await client.query('COMMIT');

      auditLog({
        actor: { id: ws.userId, username: ws.username },
        action: 'tenant.signup',
        targetType: 'tenant',
        targetId: ws.tenantId,
        payload: { source: 'self_serve', resellerId: ws.resellerId },
        tenantId: ws.tenantId,
        from: req,
      });

      if (mustVerify) {
        // Delivery is best-effort and deliberately outside the transaction: a
        // dead SMTP host must not destroy an account that was already created.
        // They can always ask for a new link.
        const brandName = await brandNameFor(ws.resellerId);
        const sent = await verification.sendVerificationEmail({ to: email, token: rawToken, brandName });
        if (!sent.ok) console.error('[auth] verification email failed:', sent.error);
        return res.status(201).json({ verificationRequired: true, email, emailSent: !!sent.ok });
      }

      const session = await loadUserSession(ws.userId);
      setAuthCookie(res, signToken({ id: ws.userId, username: ws.username, display_name: b.displayName, role: 'admin' }));
      return res.status(201).json({ user: session, verificationRequired: false });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      if (err && err.code === '23505' && attempt < 2) continue; // lost a race — rebuild and retry
      console.error('[auth] signup error:', err.message);
      return res.status(500).json({ error: 'Could not create your account. Please try again.' });
    } finally {
      client.release();
    }
  }
  return res.status(500).json({ error: 'Could not create your account. Please try again.' });
});

// POST /api/auth/verify-email — public. Body: { token }. Consumes the emailed
// token and signs the person straight in, so the link lands them in the app.
router.post('/auth/verify-email', async (req, res) => {
  const { token } = req.body || {};
  const result = await verification.consumeToken(token);
  if (!result.ok) {
    return res.status(400).json({
      error: 'This confirmation link is invalid or has expired. Request a new one.',
      code: 'VERIFY_INVALID',
    });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, username, display_name, role, is_active FROM coexistence.z_chat_users WHERE id = $1',
      [result.userId]
    );
    const user = rows[0];
    if (!user || user.is_active === false) return res.status(403).json({ error: 'Account is disabled.' });
    setAuthCookie(res, signToken(user));
    pool.query('UPDATE coexistence.z_chat_users SET last_login_at = NOW() WHERE id = $1', [user.id]).catch(() => {});
    const session = await loadUserSession(user.id);
    res.json({ user: session });
  } catch (err) {
    console.error('[auth] verify-email error:', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /api/auth/resend-verification — public. Body: { email }.
// Always reports success: a differing response would let anyone probe which
// addresses have accounts.
router.post('/auth/resend-verification', signupLimiter, async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const ok = { ok: true, message: 'If that account needs confirming, we\'ve sent a new link.' };
  if (!email || !verification.verificationRequired()) return res.json(ok);
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT u.id, u.email, t.reseller_id
         FROM coexistence.z_chat_users u
         LEFT JOIN coexistence.tenants t ON t.id = u.tenant_id
        WHERE u.email = $1 AND u.email_verified_at IS NULL AND u.signup_source = 'self_serve'`,
      [email]
    );
    if (!rows.length) return res.json(ok);
    await client.query('BEGIN');
    const raw = await verification.issueToken(client, rows[0].id);
    await client.query('COMMIT');
    const brandName = await brandNameFor(rows[0].reseller_id);
    await verification.sendVerificationEmail({ to: rows[0].email, token: raw, brandName });
    res.json(ok);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[auth] resend-verification error:', err.message);
    res.json(ok);
  } finally {
    client.release();
  }
});

// The name to put in outbound mail: a partner's customer must never receive an
// email branded "Zen Chat". Falls back to our own name for platform-direct.
async function brandNameFor(resellerId) {
  if (!resellerId) return 'Zen Chat';
  try {
    const { rows } = await pool.query('SELECT name, branding FROM coexistence.resellers WHERE id = $1', [resellerId]);
    if (!rows.length) return 'Zen Chat';
    return rows[0].branding?.brandName || rows[0].name || 'Zen Chat';
  } catch { return 'Zen Chat'; }
}

// Verify a raw JWT and return its payload, or null if missing/invalid/expired.
// Exposed so other modules (e.g. the rate limiter) can derive a *trusted* user
// identity from the cookie without trusting an unverified decode.
function verifyToken(token) {
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

module.exports = { router, authMiddleware, ensureTables, COOKIE_NAME, verifyToken, signToken, setAuthCookie, loadUserSession };
