const { Router } = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { effectivePages } = require('./permissions');
const { isStrong } = require('./util/instanceSecrets');

async function loadUserSession(userId) {
  const { rows } = await pool.query(
    `SELECT id, username, email, display_name, role, permissions, is_active, last_login_at, tenant_id
       FROM coexistence.z_chat_users WHERE id = $1`,
    [userId]
  );
  const u = rows[0];
  if (!u) return null;
  const { rows: waRows } = await pool.query(
    `SELECT wa_number FROM coexistence.user_wa_assignments WHERE user_id = $1`,
    [userId]
  );
  // SaaS: surface whether this is a platform super admin so the UI can show the
  // platform console. Tolerate the RBAC tables not existing yet (pre-migration).
  let isSuperAdmin = false;
  try {
    const { rows: sa } = await pool.query(
      `SELECT 1 FROM coexistence.user_roles ur
         JOIN coexistence.roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND r.key = 'super_admin' LIMIT 1`,
      [userId]
    );
    isSuperAdmin = sa.length > 0;
  } catch { /* RBAC tables not migrated yet — treat as non-super-admin */ }
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
    isSuperAdmin,
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

// Verify a raw JWT and return its payload, or null if missing/invalid/expired.
// Exposed so other modules (e.g. the rate limiter) can derive a *trusted* user
// identity from the cookie without trusting an unverified decode.
function verifyToken(token) {
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

module.exports = { router, authMiddleware, ensureTables, COOKIE_NAME, verifyToken, signToken, setAuthCookie, loadUserSession };
