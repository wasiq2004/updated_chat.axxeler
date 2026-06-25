// Impersonation — SaaS Phase 6 (PRD §13).
//
// A super admin starts a time-limited, audited impersonation of a tenant user.
// We issue an impersonation JWT for the TARGET user carrying an `imp` claim
// ({ sessionId, by, byName }); the existing authMiddleware then treats the
// request as that user, while sensitive actions are denied by
// blockDuringImpersonation. Stopping ends the DB session and restores the super
// admin's own session cookie.

const { Router } = require('express');
const pool = require('../db');
const { requireSuperAdmin } = require('../rbac');
const { auditLog } = require('../middleware/access');
const { signToken, setAuthCookie, COOKIE_NAME } = require('../auth');

const router = Router();

const TTL_MIN = parseInt(process.env.IMPERSONATION_TTL_MIN, 10) || 30;

function clientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').trim() || null;
}

// POST /platform/impersonate  { targetUserId, reason }  (super admin only)
router.post('/platform/impersonate', requireSuperAdmin, async (req, res) => {
  const { targetUserId, reason } = req.body || {};
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required' });
  if (!reason?.trim()) return res.status(400).json({ error: 'A reason is required to impersonate.' });

  try {
    const { rows } = await pool.query(
      `SELECT id, username, display_name, role, tenant_id, is_active
         FROM coexistence.z_chat_users WHERE id = $1`,
      [targetUserId]
    );
    const target = rows[0];
    if (!target) return res.status(404).json({ error: 'Target user not found' });
    if (target.is_active === false) return res.status(400).json({ error: 'Target user is disabled' });
    if (target.tenant_id == null) return res.status(400).json({ error: 'Cannot impersonate a platform user' });

    const ip = clientIp(req);
    const expiresAt = new Date(Date.now() + TTL_MIN * 60 * 1000);
    const sess = await pool.query(
      `INSERT INTO coexistence.impersonation_sessions
         (super_admin_id, target_user_id, tenant_id, reason, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.user.id, target.id, target.tenant_id, reason.trim(), ip, expiresAt]
    );
    const sessionId = sess.rows[0].id;

    // Impersonation token for the target, expiring with the session.
    const token = signToken(
      target,
      { imp: { sessionId, by: req.user.id, byName: req.user.username } },
      `${TTL_MIN}m`
    );
    setAuthCookie(res, token, TTL_MIN * 60 * 1000);

    await auditLog({
      actor: req.user, action: 'platform.impersonation.start',
      targetType: 'user', targetId: target.id, tenantId: target.tenant_id, ip,
      payload: { reason: reason.trim(), sessionId },
    });

    res.json({
      ok: true,
      sessionId,
      expiresAt,
      impersonating: { id: target.id, username: target.username, displayName: target.display_name },
    });
  } catch (err) {
    console.error('[impersonation] start error:', err.message);
    res.status(500).json({ error: 'Failed to start impersonation' });
  }
});

// POST /auth/impersonation/stop — ends impersonation, restores the super admin.
// Available to the impersonated session (its JWT carries `imp`).
router.post('/auth/impersonation/stop', async (req, res) => {
  const imp = req.user?.imp;
  if (!imp?.sessionId) return res.status(400).json({ error: 'Not currently impersonating' });

  try {
    await pool.query(
      `UPDATE coexistence.impersonation_sessions SET ended_at = NOW()
        WHERE id = $1 AND ended_at IS NULL`,
      [imp.sessionId]
    );
    const { rows } = await pool.query(
      `SELECT id, username, display_name, role FROM coexistence.z_chat_users WHERE id = $1`,
      [imp.by]
    );
    const superAdmin = rows[0];
    if (!superAdmin) {
      res.clearCookie(COOKIE_NAME);
      return res.status(401).json({ error: 'Original account not found; please sign in again.' });
    }
    setAuthCookie(res, signToken(superAdmin));
    await auditLog({
      actor: superAdmin, action: 'platform.impersonation.stop',
      targetType: 'user', targetId: req.user.id, ip: clientIp(req),
      payload: { sessionId: imp.sessionId },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[impersonation] stop error:', err.message);
    res.status(500).json({ error: 'Failed to stop impersonation' });
  }
});

module.exports = router;
