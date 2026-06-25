// Tenant audit log (SaaS Phase 6). A tenant admin can review the audit trail
// scoped to their own tenant. Platform-wide audit lives under /platform/audit
// (super admin only). Gated by the audit.view permission.

const { Router } = require('express');
const pool = require('../db');
const { requirePerm } = require('../rbac');

const router = Router();

// GET /api/audit?limit=&action=
router.get('/audit', requirePerm('audit.view'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const params = [];
    const where = [];
    if (req.tenantId != null) { params.push(req.tenantId); where.push(`tenant_id = $${params.length}`); }
    if (req.query.action) { params.push(String(req.query.action)); where.push(`action = $${params.length}`); }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, actor_user_id, actor_username, action, target_type, target_id,
              organization_id, ip_address, payload, created_at
         FROM coexistence.user_audit_log
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[audit] list error:', err.message);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

module.exports = router;
