// Platform (Super Admin) API — SaaS Phase 3.
//
// Every route here is gated to platform super admins (no tenant). It manages the
// platform itself: tenants (create/suspend/activate), plans & features catalog,
// per-tenant subscriptions, and high-level platform stats + audit. Mounted under
// authMiddleware + tenantContext in index.js, then locked down by requireSuperAdmin.
//
// All mutations are recorded in the shared audit log with the platform actor.

const { Router } = require('express');
const pool = require('../db');
const { requireSuperAdmin } = require('../rbac');
const { auditLog } = require('../middleware/access');

const router = Router();

// Lock the entire router to super admins.
router.use('/platform', requireSuperAdmin);

function slugify(s) {
  return String(s || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').trim() || null;
}

// ─── Platform stats ─────────────────────────────────────────────────────────
router.get('/platform/stats', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM coexistence.tenants WHERE deleted_at IS NULL)                   AS tenants,
        (SELECT COUNT(*)::int FROM coexistence.tenants WHERE status = 'active' AND deleted_at IS NULL) AS active_tenants,
        (SELECT COUNT(*)::int FROM coexistence.tenants WHERE status = 'suspended' AND deleted_at IS NULL) AS suspended_tenants,
        (SELECT COUNT(*)::int FROM coexistence.organizations WHERE deleted_at IS NULL)             AS organizations,
        (SELECT COUNT(*)::int FROM coexistence.z_chat_users)                                       AS users,
        (SELECT COUNT(*)::int FROM coexistence.subscriptions WHERE status IN ('active','trialing')) AS live_subscriptions
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error('[platform] stats error:', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ─── Tenants ────────────────────────────────────────────────────────────────
router.get('/platform/tenants', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.slug, t.status, t.created_at, t.trial_ends_at,
             p.key AS plan_key, p.name AS plan_name,
             (SELECT COUNT(*)::int FROM coexistence.organizations o WHERE o.tenant_id = t.id AND o.deleted_at IS NULL) AS organizations,
             (SELECT COUNT(*)::int FROM coexistence.z_chat_users u WHERE u.tenant_id = t.id) AS users
        FROM coexistence.tenants t
        LEFT JOIN coexistence.plans p ON p.id = t.plan_id
       WHERE t.deleted_at IS NULL
       ORDER BY t.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[platform] list tenants error:', err.message);
    res.status(500).json({ error: 'Failed to list tenants' });
  }
});

router.get('/platform/tenants/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, p.key AS plan_key, p.name AS plan_name
         FROM coexistence.tenants t
         LEFT JOIN coexistence.plans p ON p.id = t.plan_id
        WHERE t.id = $1 AND t.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    const { rows: orgs } = await pool.query(
      `SELECT id, name, slug, status, created_at FROM coexistence.organizations
        WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY id`,
      [req.params.id]
    );
    const { rows: subs } = await pool.query(
      `SELECT s.id, s.status, s.billing_cycle, s.current_period_start, s.current_period_end,
              p.key AS plan_key, p.name AS plan_name
         FROM coexistence.subscriptions s JOIN coexistence.plans p ON p.id = s.plan_id
        WHERE s.tenant_id = $1 ORDER BY s.id DESC`,
      [req.params.id]
    );
    res.json({ ...rows[0], organizations: orgs, subscriptions: subs });
  } catch (err) {
    console.error('[platform] get tenant error:', err.message);
    res.status(500).json({ error: 'Failed to load tenant' });
  }
});

// List a tenant's users (for the impersonation picker).
router.get('/platform/tenants/:id/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.email, u.display_name, u.role, u.is_active, u.last_login_at
         FROM coexistence.z_chat_users u
        WHERE u.tenant_id = $1
        ORDER BY u.created_at`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[platform] tenant users error:', err.message);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// Create a tenant + its first organization + an active subscription.
router.post('/platform/tenants', async (req, res) => {
  const { name, slug, planKey = 'starter', billingCycle = 'monthly' } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  const client = await pool.connect();
  try {
    const planRes = await client.query('SELECT id FROM coexistence.plans WHERE key = $1', [planKey]);
    const planId = planRes.rows[0]?.id;
    if (!planId) return res.status(400).json({ error: `Unknown plan '${planKey}'` });

    const baseSlug = slugify(slug || name) || 'tenant';
    let finalSlug = baseSlug;
    for (let i = 0; ; i++) {
      const exists = await client.query('SELECT 1 FROM coexistence.tenants WHERE slug = $1', [finalSlug]);
      if (exists.rows.length === 0) break;
      finalSlug = `${baseSlug}-${i + 1}`;
    }

    await client.query('BEGIN');
    const t = await client.query(
      `INSERT INTO coexistence.tenants (name, slug, status, plan_id, created_by)
       VALUES ($1, $2, 'active', $3, $4) RETURNING *`,
      [name.trim(), finalSlug, planId, req.user.id]
    );
    const tenant = t.rows[0];
    const o = await client.query(
      `INSERT INTO coexistence.organizations (tenant_id, name, slug, status, created_by)
       VALUES ($1, 'Default', 'default', 'active', $2) RETURNING id`,
      [tenant.id, req.user.id]
    );
    await client.query(
      `INSERT INTO coexistence.subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_start)
       VALUES ($1, $2, 'active', $3, NOW())`,
      [tenant.id, planId, billingCycle === 'yearly' ? 'yearly' : 'monthly']
    );
    await client.query('COMMIT');

    await auditLog({
      actor: req.user, action: 'platform.tenant.create',
      targetType: 'tenant', targetId: tenant.id,
      payload: { name: tenant.name, slug: tenant.slug, planKey, ip: clientIp(req) },
    });
    res.status(201).json({ ...tenant, defaultOrganizationId: o.rows[0].id });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[platform] create tenant error:', err.message);
    res.status(500).json({ error: 'Failed to create tenant' });
  } finally {
    client.release();
  }
});

// Update name and/or status (suspend / activate).
router.patch('/platform/tenants/:id', async (req, res) => {
  const { name, status } = req.body || {};
  if (status && !['active', 'trial', 'suspended', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const fields = [];
    const params = [];
    let i = 1;
    if (name != null)   { fields.push(`name = $${i++}`);   params.push(String(name).trim()); }
    if (status != null) { fields.push(`status = $${i++}`); params.push(status); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push('updated_at = NOW()');
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE coexistence.tenants SET ${fields.join(', ')}
        WHERE id = $${i} AND deleted_at IS NULL RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    await auditLog({
      actor: req.user, action: 'platform.tenant.update',
      targetType: 'tenant', targetId: req.params.id,
      payload: { name, status, ip: clientIp(req) },
    });
    res.json(rows[0]);
  } catch (err) {
    console.error('[platform] update tenant error:', err.message);
    res.status(500).json({ error: 'Failed to update tenant' });
  }
});

// Change a tenant's plan (creates a new active subscription, retires the old).
router.post('/platform/tenants/:id/subscription', async (req, res) => {
  const { planKey, billingCycle = 'monthly' } = req.body || {};
  const client = await pool.connect();
  try {
    const planRes = await client.query('SELECT id FROM coexistence.plans WHERE key = $1', [planKey]);
    const planId = planRes.rows[0]?.id;
    if (!planId) return res.status(400).json({ error: `Unknown plan '${planKey}'` });
    const tRes = await client.query(
      'SELECT 1 FROM coexistence.tenants WHERE id = $1 AND deleted_at IS NULL', [req.params.id]
    );
    if (!tRes.rows.length) return res.status(404).json({ error: 'Tenant not found' });

    await client.query('BEGIN');
    await client.query(
      `UPDATE coexistence.subscriptions SET status = 'cancelled', updated_at = NOW()
        WHERE tenant_id = $1 AND status IN ('active','trialing','past_due')`,
      [req.params.id]
    );
    const s = await client.query(
      `INSERT INTO coexistence.subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_start)
       VALUES ($1, $2, 'active', $3, NOW()) RETURNING *`,
      [req.params.id, planId, billingCycle === 'yearly' ? 'yearly' : 'monthly']
    );
    await client.query('UPDATE coexistence.tenants SET plan_id = $1, updated_at = NOW() WHERE id = $2',
      [planId, req.params.id]);
    await client.query('COMMIT');

    await auditLog({
      actor: req.user, action: 'platform.subscription.change',
      targetType: 'tenant', targetId: req.params.id,
      payload: { planKey, billingCycle, ip: clientIp(req) },
    });
    res.status(201).json(s.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[platform] change subscription error:', err.message);
    res.status(500).json({ error: 'Failed to change subscription' });
  } finally {
    client.release();
  }
});

// ─── Plans & features catalog ─────────────────────────────────────────────────
router.get('/platform/plans', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.key, p.name, p.description, p.price_monthly, p.price_yearly, p.currency,
             p.max_users, p.max_organizations, p.max_contacts, p.is_active, p.position,
             COALESCE(
               (SELECT json_agg(f.key ORDER BY f.key)
                  FROM coexistence.plan_features pf
                  JOIN coexistence.features f ON f.id = pf.feature_id
                 WHERE pf.plan_id = p.id), '[]'
             ) AS features
        FROM coexistence.plans p
       ORDER BY p.position, p.id
    `);
    res.json(rows);
  } catch (err) {
    console.error('[platform] plans error:', err.message);
    res.status(500).json({ error: 'Failed to load plans' });
  }
});

router.get('/platform/features', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, key, name, description FROM coexistence.features ORDER BY key'
    );
    res.json(rows);
  } catch (err) {
    console.error('[platform] features error:', err.message);
    res.status(500).json({ error: 'Failed to load features' });
  }
});

// ─── Platform-wide audit log ──────────────────────────────────────────────────
router.get('/platform/audit', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const { rows } = await pool.query(
      `SELECT id, actor_user_id, actor_username, action, target_type, target_id,
              tenant_id, organization_id, ip_address, payload, created_at
         FROM coexistence.user_audit_log
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('[platform] audit error:', err.message);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

module.exports = router;
