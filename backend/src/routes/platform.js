// Platform (Super Admin) API — SaaS Phase 3.
//
// Every route here is gated to platform super admins (no tenant). It manages the
// platform itself: tenants (create/suspend/activate), plans & features catalog,
// per-tenant subscriptions, and high-level platform stats + audit. Mounted under
// authMiddleware + tenantContext in index.js, then locked down by requireSuperAdmin.
//
// All mutations are recorded in the shared audit log with the platform actor.

const { Router } = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireSuperAdmin, requirePlatformOrReseller } = require('../rbac');
const { auditLog } = require('../middleware/access');

const router = Router();

// The console is shared by the platform owner AND white-label reseller admins.
// Every read below is scoped by scopeId(req): a reseller sees only their own
// resellers' admins/plans; the platform owner sees platform-direct ones. Routes
// that manage resellers themselves add an extra requireSuperAdmin gate.
router.use('/platform', requirePlatformOrReseller);

// The catalog/hierarchy this operator owns: their reseller_id, or NULL for the
// platform owner. Used as the value in `reseller_id IS NOT DISTINCT FROM $n`.
function scopeId(req) {
  return (req.isResellerAdmin && req.resellerId != null) ? req.resellerId : null;
}

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

// Generate a readable one-time password (shown once to the super admin).
function generatePassword() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const b = 'abcdefghijkmnpqrstuvwxyz';
  const d = '23456789';
  const pick = (s, n) => Array.from({ length: n }, () => s[Math.floor(Math.random() * s.length)]).join('');
  return `${pick(a, 2)}${pick(b, 5)}${pick(d, 3)}`;
}

// Reserve a globally-unique username derived from an email local-part.
async function uniqueUsername(client, email) {
  const base = String(email).split('@')[0].replace(/[^a-z0-9_.-]/gi, '') || 'admin';
  let username = base;
  for (let i = 0; ; i++) {
    const exists = await client.query(
      'SELECT 1 FROM coexistence.z_chat_users WHERE username = $1', [username]
    );
    if (exists.rows.length === 0) return username;
    username = `${base}${i + 1}`;
  }
}

// SQL fragment: a fresh period end one billing cycle from now.
function periodEndExpr(billingCycle) {
  return billingCycle === 'yearly'
    ? `NOW() + INTERVAL '1 year'`
    : `NOW() + INTERVAL '1 month'`;
}

// ─── Platform stats ─────────────────────────────────────────────────────────
router.get('/platform/stats', async (req, res) => {
  try {
    // $1 = the operator's scope (reseller id, or NULL for the platform owner).
    // "...tenant_id IN (scoped tenants)" keeps non-tenant tables in the hierarchy.
    const rid = scopeId(req);
    const { rows } = await pool.query(`
      WITH scoped AS (
        SELECT id FROM coexistence.tenants
         WHERE deleted_at IS NULL AND reseller_id IS NOT DISTINCT FROM $1
      )
      SELECT
        (SELECT COUNT(*)::int FROM scoped)                                                          AS tenants,
        (SELECT COUNT(*)::int FROM coexistence.tenants WHERE status = 'active' AND deleted_at IS NULL AND reseller_id IS NOT DISTINCT FROM $1) AS active_tenants,
        (SELECT COUNT(*)::int FROM coexistence.tenants WHERE status = 'suspended' AND deleted_at IS NULL AND reseller_id IS NOT DISTINCT FROM $1) AS suspended_tenants,
        (SELECT COUNT(*)::int FROM coexistence.tenants
           WHERE deleted_at IS NULL AND reseller_id IS NOT DISTINCT FROM $1 AND created_at >= date_trunc('month', NOW())) AS new_tenants_this_month,
        (SELECT COUNT(*)::int FROM coexistence.organizations WHERE deleted_at IS NULL AND tenant_id IN (SELECT id FROM scoped)) AS organizations,
        (SELECT COUNT(*)::int FROM coexistence.z_chat_users WHERE tenant_id IN (SELECT id FROM scoped)) AS users,
        (SELECT COUNT(*)::int FROM coexistence.subscriptions WHERE status IN ('active','trialing','past_due') AND tenant_id IN (SELECT id FROM scoped)) AS live_subscriptions,
        (SELECT COUNT(*)::int FROM coexistence.subscriptions
           WHERE status IN ('active','trialing','past_due')
             AND tenant_id IN (SELECT id FROM scoped)
             AND current_period_end IS NOT NULL
             AND current_period_end BETWEEN NOW() AND NOW() + INTERVAL '7 days')                   AS expiring_soon,
        (SELECT COUNT(*)::int FROM coexistence.subscriptions WHERE status = 'suspended' AND tenant_id IN (SELECT id FROM scoped)) AS suspended_subscriptions,
        -- Monthly recurring revenue: normalize yearly plans to a monthly figure.
        (SELECT COALESCE(ROUND(SUM(
                  CASE WHEN s.billing_cycle = 'yearly'
                       THEN COALESCE(p.price_yearly, p.price_monthly * 12) / 12.0
                       ELSE p.price_monthly END
                ), 2), 0)
           FROM coexistence.subscriptions s JOIN coexistence.plans p ON p.id = s.plan_id
          WHERE s.status IN ('active','trialing') AND s.tenant_id IN (SELECT id FROM scoped))       AS mrr
    `, [rid]);

    // Live-subscription distribution by plan, for a quick revenue-by-tier view.
    const { rows: byPlan } = await pool.query(`
      SELECT p.key AS plan_key, p.name AS plan_name, COUNT(*)::int AS tenants,
             COALESCE(p.price_monthly, 0) AS price_monthly
        FROM coexistence.subscriptions s JOIN coexistence.plans p ON p.id = s.plan_id
       WHERE s.status IN ('active','trialing','past_due')
         AND s.tenant_id IN (SELECT id FROM coexistence.tenants WHERE deleted_at IS NULL AND reseller_id IS NOT DISTINCT FROM $1)
       GROUP BY p.id, p.key, p.name, p.price_monthly, p.position
       ORDER BY p.position, p.id
    `, [rid]);

    res.json({ ...rows[0], plan_distribution: byPlan });
  } catch (err) {
    console.error('[platform] stats error:', err.message);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ─── Tenants ────────────────────────────────────────────────────────────────
router.get('/platform/tenants', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.slug, t.status, t.created_at, t.trial_ends_at,
             p.key AS plan_key, p.name AS plan_name,
             (SELECT COUNT(*)::int FROM coexistence.organizations o WHERE o.tenant_id = t.id AND o.deleted_at IS NULL) AS organizations,
             (SELECT COUNT(*)::int FROM coexistence.z_chat_users u WHERE u.tenant_id = t.id) AS users
        FROM coexistence.tenants t
        LEFT JOIN coexistence.plans p ON p.id = t.plan_id
       WHERE t.deleted_at IS NULL AND t.reseller_id IS NOT DISTINCT FROM $1
       ORDER BY t.created_at DESC
    `, [scopeId(req)]);
    res.json(rows);
  } catch (err) {
    console.error('[platform] list tenants error:', err.message);
    res.status(500).json({ error: 'Failed to list tenants' });
  }
});

router.get('/platform/tenants/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, p.key AS plan_key, p.name AS plan_name,
              p.max_users, p.max_organizations, p.max_contacts
         FROM coexistence.tenants t
         LEFT JOIN coexistence.plans p ON p.id = t.plan_id
        WHERE t.id = $1 AND t.deleted_at IS NULL AND t.reseller_id IS NOT DISTINCT FROM $2`,
      [req.params.id, scopeId(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    // Real usage for this admin (workspace), to compare against plan limits.
    const { rows: usageRows } = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM coexistence.z_chat_users WHERE tenant_id = $1)                               AS users,
         (SELECT COUNT(*)::int FROM coexistence.organizations WHERE tenant_id = $1 AND deleted_at IS NULL)       AS organizations,
         (SELECT COUNT(*)::int FROM coexistence.contacts WHERE tenant_id = $1)                                   AS contacts,
         (SELECT COUNT(*)::int FROM coexistence.chat_history WHERE tenant_id = $1)                               AS messages,
         (SELECT MAX(last_login_at) FROM coexistence.z_chat_users WHERE tenant_id = $1)                          AS last_login`,
      [req.params.id]
    );
    const usage = usageRows[0] || {};
    const { rows: orgs } = await pool.query(
      `SELECT o.id, o.name, o.slug, o.status, o.created_at,
              (SELECT COUNT(DISTINCT ur.user_id)::int
                 FROM coexistence.user_roles ur
                WHERE ur.organization_id = o.id) AS member_count
         FROM coexistence.organizations o
        WHERE o.tenant_id = $1 AND o.deleted_at IS NULL ORDER BY o.id`,
      [req.params.id]
    );
    // All users in the tenant, each tagged with the org they're scoped to (NULL =
    // tenant-wide, e.g. the admin). DISTINCT-on keeps one row per user.
    const { rows: users } = await pool.query(
      `SELECT DISTINCT ON (u.id)
              u.id, u.username, u.email, u.display_name, u.role, u.is_active,
              u.last_login_at, u.created_at, ur.organization_id
         FROM coexistence.z_chat_users u
         LEFT JOIN coexistence.user_roles ur ON ur.user_id = u.id
        WHERE u.tenant_id = $1
        ORDER BY u.id, ur.organization_id NULLS FIRST`,
      [req.params.id]
    );
    const { rows: subs } = await pool.query(
      `SELECT s.id, s.status, s.billing_cycle, s.current_period_start, s.current_period_end,
              p.key AS plan_key, p.name AS plan_name, p.price_monthly, p.price_yearly
         FROM coexistence.subscriptions s JOIN coexistence.plans p ON p.id = s.plan_id
        WHERE s.tenant_id = $1 ORDER BY s.id DESC`,
      [req.params.id]
    );
    const admin = users.find(u => u.role === 'admin') || null;
    res.json({
      ...rows[0], organizations: orgs, users, subscriptions: subs, admin,
      usage: {
        users: usage.users ?? 0,
        organizations: usage.organizations ?? 0,
        contacts: usage.contacts ?? 0,
        messages: usage.messages ?? 0,
        lastLogin: usage.last_login ?? null,
        limits: {
          max_users: rows[0].max_users,
          max_organizations: rows[0].max_organizations,
          max_contacts: rows[0].max_contacts,
        },
      },
    });
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
          AND u.tenant_id IN (SELECT id FROM coexistence.tenants WHERE reseller_id IS NOT DISTINCT FROM $2)
        ORDER BY u.created_at`,
      [req.params.id, scopeId(req)]
    );
    res.json(rows);
  } catch (err) {
    console.error('[platform] tenant users error:', err.message);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// Create a tenant ("admin") + its first organization + an active subscription,
// AND the tenant's admin login so they can sign in immediately. The super admin
// supplies the admin's email (required) and optionally a password (auto-generated
// and returned once if omitted). The admin gets role='admin' + the tenant_admin
// system role so they can manage their own organizations and users.
router.post('/platform/tenants', async (req, res) => {
  const {
    name, slug, planKey = 'starter', billingCycle = 'monthly',
    adminEmail, adminPassword, adminName,
  } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const email = String(adminEmail || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid admin email is required' });
  }

  const rid = scopeId(req);
  const client = await pool.connect();
  try {
    // Plan must come from the operator's OWN catalog (reseller's, or platform's).
    const planRes = await client.query(
      'SELECT id FROM coexistence.plans WHERE key = $1 AND reseller_id IS NOT DISTINCT FROM $2', [planKey, rid]);
    const planId = planRes.rows[0]?.id;
    if (!planId) return res.status(400).json({ error: `Unknown plan '${planKey}'` });

    const dupe = await client.query('SELECT 1 FROM coexistence.z_chat_users WHERE email = $1', [email]);
    if (dupe.rows.length) return res.status(409).json({ error: 'A user with that email already exists' });

    const baseSlug = slugify(slug || name) || 'tenant';
    let finalSlug = baseSlug;
    for (let i = 0; ; i++) {
      const exists = await client.query('SELECT 1 FROM coexistence.tenants WHERE slug = $1', [finalSlug]);
      if (exists.rows.length === 0) break;
      finalSlug = `${baseSlug}-${i + 1}`;
    }

    const cycle = billingCycle === 'yearly' ? 'yearly' : 'monthly';
    const finalPassword = String(adminPassword || '').trim() || generatePassword();
    const hash = await bcrypt.hash(finalPassword, 10);

    await client.query('BEGIN');
    const t = await client.query(
      `INSERT INTO coexistence.tenants (name, slug, status, plan_id, reseller_id, created_by)
       VALUES ($1, $2, 'active', $3, $4, $5) RETURNING *`,
      [name.trim(), finalSlug, planId, rid, req.user.id]
    );
    const tenant = t.rows[0];
    const o = await client.query(
      `INSERT INTO coexistence.organizations (tenant_id, name, slug, status, created_by)
       VALUES ($1, 'Default', 'default', 'active', $2) RETURNING id`,
      [tenant.id, req.user.id]
    );
    await client.query(
      `INSERT INTO coexistence.subscriptions
         (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', $3, NOW(), ${periodEndExpr(cycle)})`,
      [tenant.id, planId, cycle]
    );

    // The tenant's admin login.
    const username = await uniqueUsername(client, email);
    const adminRow = await client.query(
      `INSERT INTO coexistence.z_chat_users
         (username, email, password, display_name, role, tenant_id, is_active, created_by)
       VALUES ($1, $2, $3, $4, 'admin', $5, TRUE, $6) RETURNING id`,
      [username, email, hash, (adminName || name).trim(), tenant.id, req.user.id]
    );
    // Dual-write the RBAC model: tenant-wide tenant_admin role.
    await client.query(
      `INSERT INTO coexistence.user_roles (user_id, role_id, organization_id, created_by)
         SELECT $1, r.id, NULL, $2 FROM coexistence.roles r
          WHERE r.key = 'tenant_admin' AND r.tenant_id IS NULL
       ON CONFLICT DO NOTHING`,
      [adminRow.rows[0].id, req.user.id]
    );
    await client.query('COMMIT');

    await auditLog({
      actor: req.user, action: 'platform.tenant.create',
      targetType: 'tenant', targetId: tenant.id, tenantId: tenant.id,
      payload: { name: tenant.name, slug: tenant.slug, planKey, adminEmail: email, ip: clientIp(req) },
    });
    res.status(201).json({
      ...tenant,
      defaultOrganizationId: o.rows[0].id,
      admin: { id: adminRow.rows[0].id, email, username },
      // One-time plaintext so the super admin can hand off credentials.
      generatedPassword: adminPassword ? null : finalPassword,
    });
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
    const idIdx = i;
    params.push(req.params.id);
    params.push(scopeId(req));
    const { rows } = await pool.query(
      `UPDATE coexistence.tenants SET ${fields.join(', ')}
        WHERE id = $${idIdx} AND deleted_at IS NULL AND reseller_id IS NOT DISTINCT FROM $${idIdx + 1} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    await auditLog({
      actor: req.user, action: 'platform.tenant.update',
      targetType: 'tenant', targetId: req.params.id, tenantId: Number(req.params.id),
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
  const rid = scopeId(req);
  const client = await pool.connect();
  try {
    const planRes = await client.query(
      'SELECT id FROM coexistence.plans WHERE key = $1 AND reseller_id IS NOT DISTINCT FROM $2', [planKey, rid]);
    const planId = planRes.rows[0]?.id;
    if (!planId) return res.status(400).json({ error: `Unknown plan '${planKey}'` });
    const tRes = await client.query(
      'SELECT 1 FROM coexistence.tenants WHERE id = $1 AND deleted_at IS NULL AND reseller_id IS NOT DISTINCT FROM $2', [req.params.id, rid]
    );
    if (!tRes.rows.length) return res.status(404).json({ error: 'Tenant not found' });

    const cycle = billingCycle === 'yearly' ? 'yearly' : 'monthly';
    await client.query('BEGIN');
    await client.query(
      `UPDATE coexistence.subscriptions SET status = 'cancelled', updated_at = NOW()
        WHERE tenant_id = $1 AND status IN ('active','trialing','past_due','suspended')`,
      [req.params.id]
    );
    const s = await client.query(
      `INSERT INTO coexistence.subscriptions
         (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
       VALUES ($1, $2, 'active', $3, NOW(), ${periodEndExpr(cycle)}) RETURNING *`,
      [req.params.id, planId, cycle]
    );
    await client.query(
      `UPDATE coexistence.tenants SET plan_id = $1, status = 'active', updated_at = NOW() WHERE id = $2`,
      [planId, req.params.id]);
    await client.query('COMMIT');

    await auditLog({
      actor: req.user, action: 'platform.subscription.change',
      targetType: 'tenant', targetId: req.params.id, tenantId: Number(req.params.id),
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

// Renew / extend the current subscription's period (manual monthly billing).
// Extends from the later of "now" or the existing period end so renewing early
// doesn't lose remaining days. Reactivates a past_due/suspended subscription and
// un-suspends the tenant.
router.post('/platform/tenants/:id/renew', async (req, res) => {
  const months = Math.min(Math.max(parseInt(req.body?.months, 10) || 1, 1), 36);
  const client = await pool.connect();
  try {
    const subRes = await client.query(
      `SELECT s.id FROM coexistence.subscriptions s
         JOIN coexistence.tenants t ON t.id = s.tenant_id
        WHERE s.tenant_id = $1 AND s.status IN ('active','trialing','past_due','suspended')
          AND t.reseller_id IS NOT DISTINCT FROM $2
        ORDER BY s.id DESC LIMIT 1`,
      [req.params.id, scopeId(req)]
    );
    if (!subRes.rows.length) return res.status(404).json({ error: 'No subscription to renew' });

    await client.query('BEGIN');
    // Reactivating must not create a second live subscription (the partial unique
    // index idx_subscriptions_one_live forbids it). Cancel any sibling live subs
    // first so this tenant has exactly one active subscription afterwards.
    await client.query(
      `UPDATE coexistence.subscriptions SET status = 'cancelled', updated_at = NOW()
        WHERE tenant_id = $1 AND id <> $2 AND status IN ('active','trialing','past_due','suspended')`,
      [req.params.id, subRes.rows[0].id]
    );
    const s = await client.query(
      `UPDATE coexistence.subscriptions
          SET status = 'active',
              current_period_end = GREATEST(COALESCE(current_period_end, NOW()), NOW())
                                   + make_interval(months => $2),
              updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [subRes.rows[0].id, months]
    );
    await client.query(
      `UPDATE coexistence.tenants SET status = 'active', updated_at = NOW()
        WHERE id = $1 AND status = 'suspended'`,
      [req.params.id]
    );
    await client.query('COMMIT');

    await auditLog({
      actor: req.user, action: 'platform.subscription.renew',
      targetType: 'tenant', targetId: req.params.id, tenantId: Number(req.params.id),
      payload: { months, ip: clientIp(req) },
    });
    res.json(s.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[platform] renew error:', err.message);
    res.status(500).json({ error: 'Failed to renew subscription' });
  } finally {
    client.release();
  }
});

// Update a tenant admin's profile (display name / email / active state).
router.patch('/platform/users/:userId', async (req, res) => {
  const { displayName, email, isActive } = req.body || {};
  try {
    const fields = [];
    const params = [];
    let i = 1;
    if (displayName != null) { fields.push(`display_name = $${i++}`); params.push(String(displayName).trim()); }
    if (email != null) {
      const e = String(email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'Invalid email' });
      const dupe = await pool.query(
        'SELECT 1 FROM coexistence.z_chat_users WHERE email = $1 AND id <> $2', [e, req.params.userId]
      );
      if (dupe.rows.length) return res.status(409).json({ error: 'Email already in use' });
      fields.push(`email = $${i++}`); params.push(e);
    }
    if (isActive != null) { fields.push(`is_active = $${i++}`); params.push(!!isActive); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push('updated_at = NOW()');
    const idIdx = i;
    params.push(req.params.userId);
    params.push(scopeId(req));
    const { rows } = await pool.query(
      `UPDATE coexistence.z_chat_users SET ${fields.join(', ')}
        WHERE id = $${idIdx}
          AND tenant_id IN (SELECT id FROM coexistence.tenants WHERE reseller_id IS NOT DISTINCT FROM $${idIdx + 1})
        RETURNING id, username, email, display_name, role, is_active, tenant_id`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await auditLog({
      actor: req.user, action: 'platform.user.update',
      targetType: 'user', targetId: req.params.userId, tenantId: rows[0].tenant_id ?? null,
      payload: { displayName, email, isActive, ip: clientIp(req) },
    });
    res.json(rows[0]);
  } catch (err) {
    console.error('[platform] update user error:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Reset a user's password to a new one-time value (returned once).
router.post('/platform/users/:userId/reset-password', async (req, res) => {
  try {
    const newPassword = String(req.body?.password || '').trim() || generatePassword();
    const hash = await bcrypt.hash(newPassword, 10);
    const { rows } = await pool.query(
      `UPDATE coexistence.z_chat_users SET password = $1, updated_at = NOW()
        WHERE id = $2
          AND tenant_id IN (SELECT id FROM coexistence.tenants WHERE reseller_id IS NOT DISTINCT FROM $3)
        RETURNING id, username, email, tenant_id`,
      [hash, req.params.userId, scopeId(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await auditLog({
      actor: req.user, action: 'platform.user.reset_password',
      targetType: 'user', targetId: req.params.userId, tenantId: rows[0].tenant_id ?? null,
      payload: { ip: clientIp(req) },
    });
    res.json({ ...rows[0], password: newPassword });
  } catch (err) {
    console.error('[platform] reset password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ─── Plans & features catalog ─────────────────────────────────────────────────
router.get('/platform/plans', async (req, res) => {
  try {
    // Each operator manages their OWN catalog (platform's, or this reseller's).
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
       WHERE p.reseller_id IS NOT DISTINCT FROM $1
       ORDER BY p.position, p.id
    `, [scopeId(req)]);
    res.json(rows);
  } catch (err) {
    console.error('[platform] plans error:', err.message);
    res.status(500).json({ error: 'Failed to load plans' });
  }
});

// Update a plan's pricing, limits, and metadata. Limits accept null = unlimited.
router.patch('/platform/plans/:id', async (req, res) => {
  const b = req.body || {};
  const NUM = (v) => (v === '' || v == null ? null : Number(v));
  const map = {
    name: b.name != null ? String(b.name).trim() : undefined,
    description: b.description != null ? String(b.description) : undefined,
    price_monthly: b.priceMonthly != null ? Number(b.priceMonthly) : undefined,
    price_yearly: b.priceYearly != null ? Number(b.priceYearly) : undefined,
    currency: b.currency != null ? String(b.currency).trim().slice(0, 8) : undefined,
    max_users: b.maxUsers !== undefined ? NUM(b.maxUsers) : undefined,
    max_organizations: b.maxOrganizations !== undefined ? NUM(b.maxOrganizations) : undefined,
    max_contacts: b.maxContacts !== undefined ? NUM(b.maxContacts) : undefined,
    is_active: b.isActive != null ? !!b.isActive : undefined,
    position: b.position != null ? parseInt(b.position, 10) : undefined,
  };
  try {
    const fields = [];
    const params = [];
    let i = 1;
    for (const [col, val] of Object.entries(map)) {
      if (val === undefined) continue;
      if (typeof val === 'number' && Number.isNaN(val)) return res.status(400).json({ error: `Invalid number for ${col}` });
      fields.push(`${col} = $${i++}`); params.push(val);
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push('updated_at = NOW()');
    const idIdx = i;
    params.push(req.params.id);
    params.push(scopeId(req));
    const { rows } = await pool.query(
      `UPDATE coexistence.plans SET ${fields.join(', ')}
        WHERE id = $${idIdx} AND reseller_id IS NOT DISTINCT FROM $${idIdx + 1} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Plan not found' });
    await auditLog({
      actor: req.user, action: 'platform.plan.update',
      targetType: 'plan', targetId: req.params.id, payload: { ...map, ip: clientIp(req) },
    });
    res.json(rows[0]);
  } catch (err) {
    console.error('[platform] update plan error:', err.message);
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

// Create a new plan (key must be unique).
router.post('/platform/plans', async (req, res) => {
  const b = req.body || {};
  const key = slugify(b.key || b.name);
  if (!key) return res.status(400).json({ error: 'key or name is required' });
  if (!b.name?.trim()) return res.status(400).json({ error: 'name is required' });
  const rid = scopeId(req);
  try {
    const dupe = await pool.query(
      'SELECT 1 FROM coexistence.plans WHERE key = $1 AND reseller_id IS NOT DISTINCT FROM $2', [key, rid]);
    if (dupe.rows.length) return res.status(409).json({ error: `A plan with key '${key}' already exists` });
    const NUM = (v) => (v === '' || v == null ? null : Number(v));
    const { rows } = await pool.query(
      `INSERT INTO coexistence.plans
         (key, name, description, price_monthly, price_yearly, currency,
          max_users, max_organizations, max_contacts, is_active, position, reseller_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        key, b.name.trim(), b.description || null,
        Number(b.priceMonthly) || 0, Number(b.priceYearly) || 0, (b.currency || 'USD').slice(0, 8),
        NUM(b.maxUsers), NUM(b.maxOrganizations), NUM(b.maxContacts),
        b.isActive != null ? !!b.isActive : true, parseInt(b.position, 10) || 0, rid,
      ]
    );
    await auditLog({
      actor: req.user, action: 'platform.plan.create',
      targetType: 'plan', targetId: rows[0].id, payload: { key, name: b.name, ip: clientIp(req) },
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[platform] create plan error:', err.message);
    res.status(500).json({ error: 'Failed to create plan' });
  }
});

// Replace a plan's feature set. Body: { features: ["inbox","ai_agents",...] }.
router.put('/platform/plans/:id/features', async (req, res) => {
  const keys = Array.isArray(req.body?.features) ? req.body.features.map(String) : null;
  if (!keys) return res.status(400).json({ error: 'features array is required' });
  const client = await pool.connect();
  try {
    const planRes = await client.query(
      'SELECT 1 FROM coexistence.plans WHERE id = $1 AND reseller_id IS NOT DISTINCT FROM $2', [req.params.id, scopeId(req)]);
    if (!planRes.rows.length) return res.status(404).json({ error: 'Plan not found' });

    await client.query('BEGIN');
    await client.query('DELETE FROM coexistence.plan_features WHERE plan_id = $1', [req.params.id]);
    if (keys.length) {
      await client.query(
        `INSERT INTO coexistence.plan_features (plan_id, feature_id)
           SELECT $1, f.id FROM coexistence.features f WHERE f.key = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [req.params.id, keys]
      );
    }
    await client.query('COMMIT');
    await auditLog({
      actor: req.user, action: 'platform.plan.features',
      targetType: 'plan', targetId: req.params.id, payload: { features: keys, ip: clientIp(req) },
    });
    res.json({ ok: true, features: keys });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[platform] set plan features error:', err.message);
    res.status(500).json({ error: 'Failed to update plan features' });
  } finally {
    client.release();
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
    const rid = scopeId(req);
    // Platform owner sees everything; a reseller sees only their own tenants' rows.
    const filter = rid != null
      ? 'WHERE tenant_id IN (SELECT id FROM coexistence.tenants WHERE reseller_id = $2)'
      : '';
    const params = rid != null ? [limit, rid] : [limit];
    const { rows } = await pool.query(
      `SELECT id, actor_user_id, actor_username, action, target_type, target_id,
              tenant_id, organization_id, ip_address, payload, created_at
         FROM coexistence.user_audit_log
         ${filter}
        ORDER BY created_at DESC
        LIMIT $1`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[platform] audit error:', err.message);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

// ─── White-label resellers (platform owner only) ──────────────────────────────
// Creating/managing resellers is reserved for the platform super admin; a
// reseller admin can never create another reseller.
router.get('/platform/resellers', requireSuperAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.name, r.slug, r.status, r.branding, r.created_at,
             (SELECT COUNT(*)::int FROM coexistence.tenants t WHERE t.reseller_id = r.id AND t.deleted_at IS NULL) AS admins,
             (SELECT COUNT(*)::int FROM coexistence.z_chat_users u
                WHERE u.tenant_id IN (SELECT id FROM coexistence.tenants WHERE reseller_id = r.id)) AS users
        FROM coexistence.resellers r
       WHERE r.deleted_at IS NULL
       ORDER BY r.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[platform] list resellers error:', err.message);
    res.status(500).json({ error: 'Failed to list resellers' });
  }
});

// Create a reseller (white-label partner) + its scoped super-admin login.
router.post('/platform/resellers', requireSuperAdmin, async (req, res) => {
  const { name, slug, adminEmail, adminPassword, adminName, branding } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const email = String(adminEmail || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid partner admin email is required' });
  }
  const client = await pool.connect();
  try {
    const dupe = await client.query('SELECT 1 FROM coexistence.z_chat_users WHERE email = $1', [email]);
    if (dupe.rows.length) return res.status(409).json({ error: 'A user with that email already exists' });

    const baseSlug = slugify(slug || name) || 'partner';
    let finalSlug = baseSlug;
    for (let i = 0; ; i++) {
      const exists = await client.query('SELECT 1 FROM coexistence.resellers WHERE slug = $1', [finalSlug]);
      if (exists.rows.length === 0) break;
      finalSlug = `${baseSlug}-${i + 1}`;
    }

    const finalPassword = String(adminPassword || '').trim() || generatePassword();
    const hash = await bcrypt.hash(finalPassword, 10);
    const cleanBranding = sanitizeBranding(branding);

    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO coexistence.resellers (name, slug, status, branding, created_by)
       VALUES ($1, $2, 'active', $3::jsonb, $4) RETURNING *`,
      [name.trim(), finalSlug, JSON.stringify(cleanBranding), req.user.id]
    );
    const reseller = r.rows[0];
    // The partner's scoped super-admin login: a user with reseller_id + the
    // reseller_admin role, NO tenant (they operate the console, not a workspace).
    const username = await uniqueUsername(client, email);
    const adminRow = await client.query(
      `INSERT INTO coexistence.z_chat_users
         (username, email, password, display_name, role, reseller_id, is_active, created_by)
       VALUES ($1, $2, $3, $4, 'admin', $5, TRUE, $6) RETURNING id`,
      [username, email, hash, (adminName || name).trim(), reseller.id, req.user.id]
    );
    await client.query(
      `INSERT INTO coexistence.user_roles (user_id, role_id, organization_id, created_by)
         SELECT $1, ro.id, NULL, $2 FROM coexistence.roles ro
          WHERE ro.key = 'reseller_admin' AND ro.tenant_id IS NULL
       ON CONFLICT DO NOTHING`,
      [adminRow.rows[0].id, req.user.id]
    );
    await client.query('COMMIT');

    await auditLog({
      actor: req.user, action: 'platform.reseller.create',
      targetType: 'reseller', targetId: reseller.id,
      payload: { name: reseller.name, slug: reseller.slug, adminEmail: email, ip: clientIp(req) },
    });
    res.status(201).json({
      ...reseller,
      admin: { id: adminRow.rows[0].id, email, username },
      generatedPassword: adminPassword ? null : finalPassword,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[platform] create reseller error:', err.message);
    res.status(500).json({ error: 'Failed to create reseller' });
  } finally {
    client.release();
  }
});

// Update a reseller's name / status / branding.
router.patch('/platform/resellers/:id', requireSuperAdmin, async (req, res) => {
  const { name, status, branding } = req.body || {};
  if (status && !['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const fields = [];
    const params = [];
    let i = 1;
    if (name != null)     { fields.push(`name = $${i++}`);     params.push(String(name).trim()); }
    if (status != null)   { fields.push(`status = $${i++}`);   params.push(status); }
    if (branding != null) { fields.push(`branding = $${i++}::jsonb`); params.push(JSON.stringify(sanitizeBranding(branding))); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push('updated_at = NOW()');
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE coexistence.resellers SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Reseller not found' });
    await auditLog({
      actor: req.user, action: 'platform.reseller.update',
      targetType: 'reseller', targetId: req.params.id, payload: { name, status, ip: clientIp(req) },
    });
    res.json(rows[0]);
  } catch (err) {
    console.error('[platform] update reseller error:', err.message);
    res.status(500).json({ error: 'Failed to update reseller' });
  }
});

// ─── A reseller managing ITSELF (scoped to req.resellerId) ───────────────────
// Lets a white-label partner read + rebrand their own workspace. The platform
// owner (no reseller_id) gets 404 here — they use /platform/resellers instead.
router.get('/platform/my-reseller', async (req, res) => {
  if (!req.resellerId) return res.status(404).json({ error: 'Not a reseller' });
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, status, branding FROM coexistence.resellers WHERE id = $1 AND deleted_at IS NULL`,
      [req.resellerId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reseller not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[platform] my-reseller get error:', err.message);
    res.status(500).json({ error: 'Failed to load reseller' });
  }
});

router.patch('/platform/my-reseller', async (req, res) => {
  if (!req.resellerId) return res.status(404).json({ error: 'Not a reseller' });
  const { name, branding } = req.body || {};
  try {
    const fields = [];
    const params = [];
    let i = 1;
    if (name != null)     { fields.push(`name = $${i++}`); params.push(String(name).trim()); }
    if (branding != null) { fields.push(`branding = $${i++}::jsonb`); params.push(JSON.stringify(sanitizeBranding(branding))); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push('updated_at = NOW()');
    params.push(req.resellerId);
    const { rows } = await pool.query(
      `UPDATE coexistence.resellers SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL
        RETURNING id, name, slug, status, branding`,
      params
    );
    await auditLog({
      actor: req.user, action: 'reseller.self.update',
      targetType: 'reseller', targetId: req.resellerId, payload: { name, ip: clientIp(req) },
    });
    res.json(rows[0]);
  } catch (err) {
    console.error('[platform] my-reseller update error:', err.message);
    res.status(500).json({ error: 'Failed to update reseller' });
  }
});

// Keep only the recognized white-label branding fields, validated.
function sanitizeBranding(b) {
  const out = {};
  if (b && typeof b === 'object') {
    if (typeof b.brandName === 'string') out.brandName = b.brandName.slice(0, 60);
    if (typeof b.loginTagline === 'string') out.loginTagline = b.loginTagline.slice(0, 140);
    if (typeof b.logoUrl === 'string') out.logoUrl = b.logoUrl.slice(0, 500);
    if (typeof b.primaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.primaryColor)) out.primaryColor = b.primaryColor;
  }
  return out;
}

module.exports = router;
