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

// SQL fragment: the period end for a plan, given a placeholder holding its id.
// A FREE plan gets NULL — "never expires", the convention the sweeper and the
// bootstrap tenant already use. Without this a zero-price plan goes past_due one
// cycle after it is assigned and the tenant loses all access, which is nonsense
// for a plan nobody is billed for.
function planAwarePeriodEndExpr(billingCycle, planIdParam) {
  return `(SELECT CASE WHEN p.price_monthly = 0 THEN NULL ELSE ${periodEndExpr(billingCycle)} END
             FROM coexistence.plans p WHERE p.id = ${planIdParam})`;
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

// ─── Platform analytics (time series + adoption) ────────────────────────────
// Powers the console dashboard's charts. Same reseller scoping as /platform/stats.
// Every section runs independently and degrades to a safe default, so one slow or
// failing metric can't 500 the whole dashboard.
router.get('/platform/analytics', async (req, res) => {
  const rid = scopeId(req);
  const days = Math.max(7, Math.min(90, parseInt(req.query.days, 10) || 30));

  // Reusable fragments: the operator's tenants, and a gap-filled day axis so a
  // day with no activity plots as 0 instead of vanishing from the line.
  const SCOPED = `SELECT id FROM coexistence.tenants
                   WHERE deleted_at IS NULL AND reseller_id IS NOT DISTINCT FROM $1`;
  const DAY_AXIS = `SELECT generate_series(
                      date_trunc('day', NOW()) - (($2::int - 1) * INTERVAL '1 day'),
                      date_trunc('day', NOW()), INTERVAL '1 day')::date AS day`;

  const safe = async (label, fn, fallback) => {
    try { return await fn(); } catch (e) {
      console.warn(`[platform] analytics.${label} failed:`, e.message);
      return fallback;
    }
  };

  try {
    const [signups, messages, statusMix, adoption, topTenants, lifecycle] = await Promise.all([
      // New admins (tenants) per day.
      safe('signups', async () => {
        const { rows } = await pool.query(`
          WITH d AS (${DAY_AXIS})
          SELECT d.day, COALESCE(x.n, 0)::int AS count
            FROM d LEFT JOIN (
              SELECT date_trunc('day', created_at)::date AS day, COUNT(*) AS n
                FROM coexistence.tenants
               WHERE deleted_at IS NULL AND reseller_id IS NOT DISTINCT FROM $1
                 AND created_at >= date_trunc('day', NOW()) - (($2::int - 1) * INTERVAL '1 day')
               GROUP BY 1
            ) x ON x.day = d.day
           ORDER BY d.day`, [rid, days]);
        return rows;
      }, []),

      // Message volume per day, split inbound vs outbound (two series).
      safe('messages', async () => {
        const { rows } = await pool.query(`
          WITH d AS (${DAY_AXIS})
          SELECT d.day,
                 COALESCE(x.incoming, 0)::int AS incoming,
                 COALESCE(x.outgoing, 0)::int AS outgoing
            FROM d LEFT JOIN (
              SELECT date_trunc('day', c.timestamp)::date AS day,
                     COUNT(*) FILTER (WHERE c.direction = 'incoming') AS incoming,
                     COUNT(*) FILTER (WHERE c.direction = 'outgoing') AS outgoing
                FROM coexistence.chat_history c
               WHERE c.tenant_id IN (${SCOPED})
                 AND c.timestamp >= date_trunc('day', NOW()) - (($2::int - 1) * INTERVAL '1 day')
               GROUP BY 1
            ) x ON x.day = d.day
           ORDER BY d.day`, [rid, days]);
        return rows;
      }, []),

      // Lifecycle mix of admins (tenants) — states, rendered with status tokens.
      safe('statusMix', async () => {
        const { rows } = await pool.query(`
          SELECT status, COUNT(*)::int AS count
            FROM coexistence.tenants
           WHERE deleted_at IS NULL AND reseller_id IS NOT DISTINCT FROM $1
           GROUP BY status`, [rid]);
        const out = { active: 0, trial: 0, suspended: 0, cancelled: 0 };
        for (const r of rows) if (r.status in out) out[r.status] = r.count;
        return out;
      }, { active: 0, trial: 0, suspended: 0, cancelled: 0 }),

      // Product adoption across the installed base.
      safe('adoption', async () => {
        const { rows } = await pool.query(`
          WITH scoped AS (${SCOPED})
          SELECT
            (SELECT COUNT(*)::int FROM coexistence.whatsapp_accounts WHERE tenant_id IN (SELECT id FROM scoped)) AS wa_accounts,
            (SELECT COUNT(*)::int FROM coexistence.whatsapp_accounts WHERE tenant_id IN (SELECT id FROM scoped) AND is_active) AS wa_active,
            (SELECT COUNT(*)::int FROM coexistence.whatsapp_accounts WHERE tenant_id IN (SELECT id FROM scoped) AND connection_method = 'embedded_signup') AS wa_via_facebook,
            (SELECT COUNT(*)::int FROM coexistence.agents WHERE tenant_id IN (SELECT id FROM scoped)) AS agents,
            (SELECT COUNT(*)::int FROM coexistence.agents WHERE tenant_id IN (SELECT id FROM scoped) AND is_active) AS agents_active,
            (SELECT COUNT(*)::int FROM coexistence.contacts WHERE tenant_id IN (SELECT id FROM scoped)) AS contacts,
            (SELECT COUNT(*)::int FROM coexistence.z_chat_users
               WHERE tenant_id IN (SELECT id FROM scoped) AND last_login_at >= NOW() - INTERVAL '30 days') AS mau,
            (SELECT COUNT(*)::int FROM coexistence.tenants t
               WHERE t.deleted_at IS NULL AND t.reseller_id IS NOT DISTINCT FROM $1
                 AND NOT EXISTS (SELECT 1 FROM coexistence.whatsapp_accounts w WHERE w.tenant_id = t.id)) AS not_activated
        `, [rid]);
        return rows[0];
      }, {}),

      // Busiest admins by message volume in the window.
      safe('topTenants', async () => {
        const { rows } = await pool.query(`
          SELECT t.id, t.name, COUNT(c.*)::int AS messages
            FROM coexistence.tenants t
            JOIN coexistence.chat_history c ON c.tenant_id = t.id
           WHERE t.deleted_at IS NULL AND t.reseller_id IS NOT DISTINCT FROM $1
             AND c.timestamp >= NOW() - ($2::int * INTERVAL '1 day')
           GROUP BY t.id, t.name
           ORDER BY messages DESC
           LIMIT 6`, [rid, days]);
        return rows;
      }, []),

      // Renewal / churn risk buckets.
      safe('lifecycle', async () => {
        const { rows } = await pool.query(`
          WITH scoped AS (${SCOPED}), live AS (
            SELECT * FROM coexistence.subscriptions
             WHERE status IN ('active','trialing','past_due') AND tenant_id IN (SELECT id FROM scoped)
          )
          SELECT
            (SELECT COUNT(*)::int FROM live WHERE current_period_end BETWEEN NOW() AND NOW() + INTERVAL '7 days')  AS expiring_7d,
            (SELECT COUNT(*)::int FROM live WHERE current_period_end BETWEEN NOW() AND NOW() + INTERVAL '14 days') AS expiring_14d,
            (SELECT COUNT(*)::int FROM live WHERE current_period_end BETWEEN NOW() AND NOW() + INTERVAL '30 days') AS expiring_30d,
            (SELECT COUNT(*)::int FROM live WHERE cancel_at_period_end = TRUE) AS pending_cancellations
        `, [rid]);
        return rows[0];
      }, {}),
    ]);

    res.json({ range: { days }, signups, messages, status_mix: statusMix, adoption, top_tenants: topTenants, lifecycle });
  } catch (err) {
    console.error('[platform] analytics error:', err.message);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// ─── Tenants ────────────────────────────────────────────────────────────────
// GET /platform/tenants?deleted=1 — the recycle bin. Without a way to SEE
// soft-deleted admins there is no way to reach the restore route, which would
// make "recoverable" true only in the database and false in the product.
router.get('/platform/tenants', async (req, res) => {
  const showDeleted = req.query.deleted === '1' || req.query.deleted === 'true';
  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.name, t.slug, t.status, t.created_at, t.trial_ends_at,
             p.key AS plan_key, p.name AS plan_name,
             (SELECT COUNT(*)::int FROM coexistence.organizations o WHERE o.tenant_id = t.id AND o.deleted_at IS NULL) AS organizations,
             (SELECT COUNT(*)::int FROM coexistence.z_chat_users u WHERE u.tenant_id = t.id) AS users,
             -- How this workspace came to exist: 'invite' (an operator created
             -- it), 'self_serve' (public signup form) or 'facebook'. Read from
             -- the owner — the oldest user in the tenant.
             (SELECT u.signup_source FROM coexistence.z_chat_users u
               WHERE u.tenant_id = t.id ORDER BY u.id ASC LIMIT 1) AS signup_source,
             (SELECT COUNT(*)::int FROM coexistence.plan_requests pr
               WHERE pr.tenant_id = t.id AND pr.status = 'pending') AS pending_plan_requests,
             t.deleted_at
        FROM coexistence.tenants t
        LEFT JOIN coexistence.plans p ON p.id = t.plan_id
       WHERE t.deleted_at IS ${showDeleted ? 'NOT NULL' : 'NULL'}
         AND t.reseller_id IS NOT DISTINCT FROM $1
       ORDER BY ${showDeleted ? 't.deleted_at' : 't.created_at'} DESC
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
       VALUES ($1, $2, 'active', $3, NOW(), ${planAwarePeriodEndExpr(cycle, '$2')})`,
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

// Delete an admin (a customer workspace). SOFT delete (tenants.deleted_at) —
// deliberately, and not negotiable: ~30 tables reference tenants(id) ON DELETE
// CASCADE, including chat_history, contacts and whatsapp_accounts. A hard DELETE
// would irrecoverably destroy every conversation the customer ever had. Soft
// delete hides the workspace everywhere (every tenant query already filters
// `deleted_at IS NULL`) and disables its logins, while leaving the data intact.
//
// Scoped by scopeId(req), like the other tenant routes: a partner can delete
// their own admins — which is also how they clear the blocker on deleting the
// partner itself. The platform owner can only delete platform-direct ones.
router.delete('/platform/tenants/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: found } = await client.query(
      `SELECT id, name FROM coexistence.tenants
        WHERE id = $1 AND deleted_at IS NULL AND reseller_id IS NOT DISTINCT FROM $2`,
      [req.params.id, scopeId(req)]
    );
    if (!found.length) return res.status(404).json({ error: 'Admin not found' });

    await client.query('BEGIN');
    await client.query(
      `UPDATE coexistence.tenants
          SET deleted_at = NOW(), status = 'cancelled', updated_at = NOW()
        WHERE id = $1`,
      [req.params.id]
    );
    // Stop billing them. The unique partial index idx_subscriptions_one_live
    // only tolerates one live row per tenant, so leaving an 'active' one behind
    // would also block a future re-create on the same tenant id.
    await client.query(
      `UPDATE coexistence.subscriptions SET status = 'cancelled', updated_at = NOW()
        WHERE tenant_id = $1 AND status IN ('active','trialing','past_due','suspended')`,
      [req.params.id]
    );
    // Withdraw anything still queued for an operator to action.
    await client.query(
      `UPDATE coexistence.plan_requests SET status = 'cancelled', updated_at = NOW()
        WHERE tenant_id = $1 AND status = 'pending'`,
      [req.params.id]
    );
    // Their logins must stop working now — deleted_at on the tenant alone does
    // not block a session (authMiddleware re-checks the USER, not the tenant).
    //
    // Release the email + username too, same as the partner delete: the row is
    // kept (audit rows and created_by point at it), but a deleted workspace must
    // not hold an address hostage — otherwise that person can never sign up
    // again with their own email, which self-serve signup makes very likely.
    // The guard matches the tombstone THIS row would carry ('...+deleted<id>'),
    // not a bare '%+deleted%'. A substring check cannot tell "already tombstoned
    // by us" from "the address legitimately contains that text" — and
    // me+deleted@gmail.com is a valid Gmail plus-address. Such a user was skipped
    // entirely: left is_active = TRUE, able to sign in to a deleted workspace.
    // Anchoring on the row's own id makes it exact and still idempotent.
    const { rowCount: disabled } = await client.query(
      `UPDATE coexistence.z_chat_users
          SET is_active = FALSE,
              email     = email    || '+deleted' || id,
              username  = username || '+deleted' || id,
              updated_at = NOW()
        WHERE tenant_id = $1
          AND email NOT LIKE ('%+deleted' || id::text)`,
      [req.params.id]
    );
    await client.query('COMMIT');

    await auditLog({
      actor: req.user, action: 'platform.tenant.delete',
      targetType: 'tenant', targetId: req.params.id, tenantId: Number(req.params.id),
      payload: { ip: clientIp(req), name: found[0].name, disabledLogins: disabled },
    });
    res.json({ ok: true, disabledLogins: disabled });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[platform] delete tenant error:', err.message);
    res.status(500).json({ error: 'Failed to delete admin' });
  } finally {
    client.release();
  }
});

// POST /platform/tenants/:id/restore — undo a soft delete.
//
// Both delete routes justify soft-deleting on the grounds that the rows stay
// "recoverable" — but the recovery was never built, so an accidental delete
// meant hand-written SQL against production. This is that missing half.
//
// Logins are re-enabled by stripping the '+deleted<id>' tombstone we appended.
// A user whose address was taken over by someone else in the meantime keeps the
// tombstone (the UPDATE would violate the unique index): reported, not silently
// skipped, so the operator knows exactly who still needs attention.
router.post('/platform/tenants/:id/restore', async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: found } = await client.query(
      `SELECT id, name FROM coexistence.tenants
        WHERE id = $1 AND deleted_at IS NOT NULL AND reseller_id IS NOT DISTINCT FROM $2`,
      [req.params.id, scopeId(req)]
    );
    if (!found.length) return res.status(404).json({ error: 'No deleted admin with that id' });

    await client.query('BEGIN');
    await client.query(
      `UPDATE coexistence.tenants
          SET deleted_at = NULL, status = 'active', updated_at = NOW()
        WHERE id = $1`,
      [req.params.id]
    );
    const { rows: users } = await client.query(
      `SELECT id, email, username FROM coexistence.z_chat_users
        WHERE tenant_id = $1 AND email LIKE ('%+deleted' || id::text)`,
      [req.params.id]
    );
    let restored = 0;
    const conflicts = [];
    for (const u of users) {
      const suffix = `+deleted${u.id}`;
      const email = u.email.slice(0, -suffix.length);
      const username = u.username.endsWith(suffix) ? u.username.slice(0, -suffix.length) : u.username;
      try {
        // Savepoint per row: one taken address must not roll back the others.
        await client.query('SAVEPOINT restore_user');
        await client.query(
          `UPDATE coexistence.z_chat_users
              SET is_active = TRUE, email = $1, username = $2, updated_at = NOW()
            WHERE id = $3`,
          [email, username, u.id]
        );
        await client.query('RELEASE SAVEPOINT restore_user');
        restored++;
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT restore_user');
        if (e.code === '23505') conflicts.push(email);
        else throw e;
      }
    }
    await client.query('COMMIT');

    await auditLog({
      actor: req.user, action: 'platform.tenant.restore',
      targetType: 'tenant', targetId: req.params.id, tenantId: Number(req.params.id),
      payload: { ip: clientIp(req), name: found[0].name, restoredLogins: restored, conflicts },
    });
    res.json({ ok: true, restoredLogins: restored, conflicts });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[platform] restore tenant error:', err.message);
    res.status(500).json({ error: 'Failed to restore admin' });
  } finally {
    client.release();
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
       VALUES ($1, $2, 'active', $3, NOW(), ${planAwarePeriodEndExpr(cycle, '$2')}) RETURNING *`,
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

// ---------------------------------------------------------------------------
// Unverified signups — the operator side of a broken mailer.
//
// When SMTP is configured the verification gate is ON. If the mailer then fails
// (rejected key, unverified sender domain), the person is created and stranded:
// they cannot log in, and "resend" fails the same way. That used to be invisible
// — a log line and nothing else. These two routes make it a support task.
// ---------------------------------------------------------------------------

// GET /platform/signups — self-serve accounts that never confirmed their email.
router.get('/platform/signups', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.created_at,
              u.verification_sent_at, u.verification_error,
              t.id AS tenant_id, t.name AS tenant_name
         FROM coexistence.z_chat_users u
         LEFT JOIN coexistence.tenants t ON t.id = u.tenant_id
        WHERE u.email_verified_at IS NULL
          AND u.signup_source = 'self_serve'
          AND u.is_active = TRUE
          AND (t.id IS NULL OR t.deleted_at IS NULL)
          AND t.reseller_id IS NOT DISTINCT FROM $1
        ORDER BY u.created_at DESC
        LIMIT 200`,
      [scopeId(req)]
    );
    res.json(rows.map(r => ({
      id: r.id,
      email: r.email,
      name: r.display_name,
      createdAt: r.created_at,
      sentAt: r.verification_sent_at,
      // Non-null means WE failed to deliver, not that they ignored it — the
      // distinction decides whether this is your problem or theirs.
      error: r.verification_error,
      tenant: r.tenant_id ? { id: r.tenant_id, name: r.tenant_name } : null,
    })));
  } catch (err) {
    console.error('[platform] signups list error:', err.message);
    res.status(500).json({ error: 'Failed to list unverified signups' });
  }
});

// POST /platform/users/:id/verify-email — confirm an address by hand.
//
// Deliberately scoped and audited: this bypasses proof that the person controls
// the address, so it must be attributable. Only reachable for a self-serve
// signup inside the operator's own hierarchy.
router.post('/platform/users/:id/verify-email', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE coexistence.z_chat_users u
          SET email_verified_at = NOW(),
              verified_by = $1,
              verification_error = NULL,
              updated_at = NOW()
         FROM coexistence.tenants t
        WHERE u.tenant_id = t.id
          AND u.id = $2
          AND u.email_verified_at IS NULL
          AND t.deleted_at IS NULL
          AND t.reseller_id IS NOT DISTINCT FROM $3
        RETURNING u.email`,
      [req.user.id, req.params.id, scopeId(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'No unverified signup with that id' });
    await auditLog({
      actor: req.user, action: 'platform.user.verify_email',
      targetType: 'user', targetId: req.params.id,
      payload: { email: rows[0].email, ip: clientIp(req) },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[platform] manual verify error:', err.message);
    res.status(500).json({ error: 'Failed to verify this account' });
  }
});

// ---------------------------------------------------------------------------
// Plan requests — the operator side of self-serve "purchase".
//
// A customer picks a paid plan; because there is no payment gateway, that lands
// here as a pending request. The operator collects payment out of band and
// approves, which performs exactly the same subscription change as
// POST /platform/tenants/:id/subscription. Scoped like everything else: a
// partner only ever sees requests from their own tenants.
// ---------------------------------------------------------------------------

// GET /platform/plan-requests?status=pending
router.get('/platform/plan-requests', async (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)
    ? req.query.status : 'pending';
  try {
    const { rows } = await pool.query(
      `SELECT pr.id, pr.status, pr.billing_cycle, pr.note, pr.created_at, pr.decided_at,
              pr.price_at_request, pr.currency_at_request,
              t.id AS tenant_id, t.name AS tenant_name, t.slug AS tenant_slug,
              p.key AS plan_key, p.name AS plan_name, p.price_monthly, p.price_yearly, p.currency,
              p.is_active AS plan_active,
              cur.key AS current_plan_key, cur.name AS current_plan_name,
              u.email AS requested_by_email, u.display_name AS requested_by_name
         FROM coexistence.plan_requests pr
         JOIN coexistence.tenants t ON t.id = pr.tenant_id
         JOIN coexistence.plans   p ON p.id = pr.plan_id
         LEFT JOIN coexistence.plans cur ON cur.id = t.plan_id
         LEFT JOIN coexistence.z_chat_users u ON u.id = pr.requested_by
        WHERE pr.status = $1
          AND t.deleted_at IS NULL
          AND t.reseller_id IS NOT DISTINCT FROM $2
        ORDER BY pr.created_at DESC
        LIMIT 200`,
      [status, scopeId(req)]
    );
    res.json(rows.map(r => ({
      id: r.id,
      status: r.status,
      billingCycle: r.billing_cycle,
      note: r.note,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      tenant: { id: r.tenant_id, name: r.tenant_name, slug: r.tenant_slug },
      plan: {
        key: r.plan_key, name: r.plan_name, currency: r.currency,
        priceMonthly: r.price_monthly, priceYearly: r.price_yearly,
        isActive: r.plan_active,
      },
      // What the customer actually agreed to. `priceChanged` means the plan has
      // been repriced since — the operator must know before they collect money,
      // because the quote and the catalog no longer say the same thing.
      priceAgreed: r.price_at_request,
      currencyAgreed: r.currency_at_request || r.currency,
      priceChanged: r.price_at_request != null
        && Number(r.price_at_request) !== Number(r.billing_cycle === 'yearly' ? r.price_yearly : r.price_monthly),
      currentPlan: r.current_plan_key ? { key: r.current_plan_key, name: r.current_plan_name } : null,
      requestedBy: r.requested_by_email ? { email: r.requested_by_email, name: r.requested_by_name } : null,
    })));
  } catch (err) {
    console.error('[platform] plan-requests list error:', err.message);
    res.status(500).json({ error: 'Failed to list plan requests' });
  }
});

// POST /platform/plan-requests/:id/approve — activate the requested plan.
// Body: { force } — proceed even when the tenant's current usage exceeds the
// requested plan's limits (an operator override for a deliberate downgrade).
router.post('/platform/plan-requests/:id/approve', async (req, res) => {
  const client = await pool.connect();
  try {
    // Re-read under the operator's scope so a partner can't approve a request
    // belonging to someone else's tenant by guessing an id. `is_active` is part
    // of the match: approving onto a retired plan silently bills the tenant
    // against a plan that no longer appears in any catalog — including their own
    // comparison grid, where their "current" plan would just be missing.
    const { rows: reqRows } = await client.query(
      `SELECT pr.id, pr.tenant_id, pr.plan_id, pr.billing_cycle,
              p.name AS plan_name, p.is_active,
              p.max_users, p.max_organizations, p.max_contacts
         FROM coexistence.plan_requests pr
         JOIN coexistence.tenants t ON t.id = pr.tenant_id
         JOIN coexistence.plans   p ON p.id = pr.plan_id
        WHERE pr.id = $1 AND pr.status = 'pending'
          AND t.deleted_at IS NULL
          AND t.reseller_id IS NOT DISTINCT FROM $2`,
      [req.params.id, scopeId(req)]
    );
    if (!reqRows.length) return res.status(404).json({ error: 'Request not found' });
    const pr = reqRows[0];
    if (!pr.is_active) {
      return res.status(409).json({
        error: `“${pr.plan_name}” is no longer an active plan. Re-activate it, or set this tenant's plan directly.`,
      });
    }
    const cycle = pr.billing_cycle === 'yearly' ? 'yearly' : 'monthly';

    // A downgrade can leave the tenant already over the new plan's limits. Limits
    // are only enforced on CREATE, so nothing would shrink — they'd simply sit
    // above their cap indefinitely, which is a silent revenue leak and a nasty
    // surprise the first time someone tries to add a user. Surface it and make
    // the operator opt in.
    if (!req.body?.force) {
      const { rows: usage } = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM coexistence.z_chat_users WHERE tenant_id = $1)                         AS users,
           (SELECT COUNT(*)::int FROM coexistence.organizations WHERE tenant_id = $1 AND deleted_at IS NULL) AS organizations,
           (SELECT COUNT(*)::int FROM coexistence.contacts WHERE tenant_id = $1)                             AS contacts`,
        [pr.tenant_id]
      );
      const u = usage[0] || {};
      const over = [];
      // NULL limit = unlimited, so only compare when a cap is actually set.
      if (pr.max_users != null && u.users > pr.max_users) over.push(`${u.users} users (limit ${pr.max_users})`);
      if (pr.max_organizations != null && u.organizations > pr.max_organizations) over.push(`${u.organizations} organizations (limit ${pr.max_organizations})`);
      if (pr.max_contacts != null && u.contacts > pr.max_contacts) over.push(`${u.contacts} contacts (limit ${pr.max_contacts})`);
      if (over.length) {
        return res.status(409).json({
          error: `This tenant already exceeds “${pr.plan_name}”: ${over.join(', ')}. Nothing is removed automatically — approve anyway to proceed.`,
          code: 'OVER_LIMIT',
          over,
        });
      }
    }

    await client.query('BEGIN');
    // Carry over any unused time BEFORE cancelling: a customer 3 days into a paid
    // month who upgrades must not forfeit the other 27. This mirrors the
    // GREATEST(...) invariant that POST /tenants/:id/renew already upholds —
    // approve used to ignore it and restart the period from NOW().
    const { rows: prevRows } = await client.query(
      `SELECT current_period_end FROM coexistence.subscriptions
        WHERE tenant_id = $1 AND status IN ('active','trialing','past_due')
        ORDER BY id DESC LIMIT 1`,
      [pr.tenant_id]
    );
    const carryFrom = prevRows[0]?.current_period_end ?? null;

    await client.query(
      `UPDATE coexistence.subscriptions SET status = 'cancelled', updated_at = NOW()
        WHERE tenant_id = $1 AND status IN ('active','trialing','past_due','suspended')`,
      [pr.tenant_id]
    );
    await client.query(
      `INSERT INTO coexistence.subscriptions
         (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
       SELECT $1, $2, 'active', $3, NOW(),
              CASE
                -- Free plan: never expires (see the sweeper's NULL convention).
                WHEN p.price_monthly = 0 THEN NULL
                -- Paid: one cycle from the later of now or their unused time.
                ELSE GREATEST(COALESCE($4::timestamptz, NOW()), NOW())
                     + ${cycle === 'yearly' ? `INTERVAL '1 year'` : `INTERVAL '1 month'`}
              END
         FROM coexistence.plans p WHERE p.id = $2`,
      [pr.tenant_id, pr.plan_id, cycle, carryFrom]
    );
    await client.query(
      `UPDATE coexistence.tenants SET plan_id = $1, status = 'active', updated_at = NOW() WHERE id = $2`,
      [pr.plan_id, pr.tenant_id]
    );
    await client.query(
      `UPDATE coexistence.plan_requests
          SET status = 'approved', decided_by = $1, decided_at = NOW(), updated_at = NOW()
        WHERE id = $2`,
      [req.user.id, pr.id]
    );
    await client.query('COMMIT');

    await auditLog({
      actor: req.user, action: 'platform.plan_request.approve',
      targetType: 'tenant', targetId: pr.tenant_id, tenantId: Number(pr.tenant_id),
      payload: { requestId: pr.id, billingCycle: cycle, ip: clientIp(req) },
    });
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[platform] approve plan-request error:', err.message);
    res.status(500).json({ error: 'Failed to approve request' });
  } finally {
    client.release();
  }
});

// POST /platform/plan-requests/:id/reject — Body: { note }
router.post('/platform/plan-requests/:id/reject', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE coexistence.plan_requests pr
          SET status = 'rejected', decided_by = $1, decided_at = NOW(),
              note = COALESCE($3, pr.note), updated_at = NOW()
         FROM coexistence.tenants t
        WHERE pr.tenant_id = t.id AND pr.id = $2 AND pr.status = 'pending'
          AND t.reseller_id IS NOT DISTINCT FROM $4`,
      [req.user.id, req.params.id, req.body?.note ? String(req.body.note).slice(0, 500) : null, scopeId(req)]
    );
    if (!rowCount) return res.status(404).json({ error: 'Request not found' });
    await auditLog({
      actor: req.user, action: 'platform.plan_request.reject',
      targetType: 'plan_request', targetId: req.params.id, payload: { ip: clientIp(req) },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[platform] reject plan-request error:', err.message);
    res.status(500).json({ error: 'Failed to reject request' });
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
        Number(b.priceMonthly) || 0, Number(b.priceYearly) || 0, (b.currency || 'INR').slice(0, 8),
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
    // Also surface the partner's console login (their scoped admin user: the
    // reseller_id row with NO tenant — see the create route below), so the
    // platform owner can see who to contact / who signs in. The password is a
    // bcrypt hash and is deliberately NOT selected — it cannot be read back;
    // issuing a new one goes through /resellers/:id/reset-password.
    const { rows } = await pool.query(`
      SELECT r.id, r.name, r.slug, r.status, r.branding, r.created_at,
             (SELECT COUNT(*)::int FROM coexistence.tenants t WHERE t.reseller_id = r.id AND t.deleted_at IS NULL) AS admins,
             (SELECT COUNT(*)::int FROM coexistence.z_chat_users u
                WHERE u.tenant_id IN (SELECT id FROM coexistence.tenants WHERE reseller_id = r.id)) AS users,
             a.id            AS admin_id,
             a.email         AS admin_email,
             a.username      AS admin_username,
             a.display_name  AS admin_name,
             a.is_active     AS admin_is_active,
             a.last_login_at AS admin_last_login_at
        FROM coexistence.resellers r
        LEFT JOIN LATERAL (
          SELECT u.id, u.email, u.username, u.display_name, u.is_active, u.last_login_at
            FROM coexistence.z_chat_users u
           WHERE u.reseller_id = r.id AND u.tenant_id IS NULL
           ORDER BY u.id ASC LIMIT 1
        ) a ON TRUE
       WHERE r.deleted_at IS NULL
       ORDER BY r.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[platform] list resellers error:', err.message);
    res.status(500).json({ error: 'Failed to list resellers' });
  }
});

// Issue a NEW console password for a partner's admin, returned once in plaintext.
// A stored password can never be shown (it is a one-way bcrypt hash), so this is
// the only way to hand a partner working credentials again.
//
// This needs its own route: /platform/users/:userId/reset-password scopes by
// `tenant_id IN (tenants of the scope)`, and a partner admin has NO tenant, so
// that route can never match one.
router.post('/platform/resellers/:id/reset-password', requireSuperAdmin, async (req, res) => {
  try {
    const newPassword = String(req.body?.password || '').trim() || generatePassword();
    const hash = await bcrypt.hash(newPassword, 10);
    const { rows } = await pool.query(
      `UPDATE coexistence.z_chat_users SET password = $1, updated_at = NOW()
        WHERE reseller_id = $2 AND tenant_id IS NULL
          AND id = (SELECT id FROM coexistence.z_chat_users
                     WHERE reseller_id = $2 AND tenant_id IS NULL ORDER BY id ASC LIMIT 1)
          AND EXISTS (SELECT 1 FROM coexistence.resellers WHERE id = $2 AND deleted_at IS NULL)
        RETURNING id, username, email`,
      [hash, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Partner admin not found' });
    await auditLog({
      actor: req.user, action: 'platform.reseller.reset_password',
      targetType: 'reseller', targetId: req.params.id,
      payload: { ip: clientIp(req), userId: rows[0].id },
    });
    res.json({ ...rows[0], password: newPassword });
  } catch (err) {
    console.error('[platform] reseller reset password error:', err.message);
    res.status(500).json({ error: 'Failed to reset partner password' });
  }
});

// Delete a partner. This is a SOFT delete (resellers.deleted_at) — deliberately.
// tenants/z_chat_users/plans reference resellers(id) ON DELETE CASCADE, so a hard
// DELETE would silently destroy the partner's customers, their logins and their
// plan catalog. Soft-deleting hides the partner and disables their console login
// while leaving the rows recoverable.
//
// Refused while the partner still has admins (tenants): those customers would be
// orphaned — invisible to the platform owner, since owner-scoped queries match
// `reseller_id IS NULL`. Remove/reassign them first, or suspend the partner.
router.delete('/platform/resellers/:id', requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: found } = await client.query(
      'SELECT id, name FROM coexistence.resellers WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!found.length) return res.status(404).json({ error: 'Not found' });

    const { rows: cnt } = await client.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.tenants
        WHERE reseller_id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (cnt[0].n > 0) {
      return res.status(409).json({
        error: `“${found[0].name}” still has ${cnt[0].n} admin account(s). Delete or reassign them first, or suspend the partner instead.`,
        admins: cnt[0].n,
      });
    }

    await client.query('BEGIN');
    await client.query(
      `UPDATE coexistence.resellers SET deleted_at = NOW(), status = 'suspended', updated_at = NOW()
        WHERE id = $1`,
      [req.params.id]
    );
    // Their console login must stop working the moment the partner is gone —
    // deleted_at on the reseller alone would not block the user's session.
    //
    // We also RELEASE the email + username. The row itself is kept (audit rows
    // and created_by references point at it), but a deleted partner must not
    // hold its address hostage: otherwise re-creating that partner with the same
    // email fails the duplicate check forever, with a confusing 409. The suffix
    // is unique per user id, so repeated deletes can't collide either.
    // Anchored on the row's own id — see the tenant delete for why a bare
    // '%+deleted%' guard silently skipped anyone whose real address contains it.
    const { rowCount: disabled } = await client.query(
      `UPDATE coexistence.z_chat_users
          SET is_active = FALSE,
              email     = email    || '+deleted' || id,
              username  = username || '+deleted' || id,
              updated_at = NOW()
        WHERE reseller_id = $1 AND tenant_id IS NULL
          AND email NOT LIKE ('%+deleted' || id::text)`,
      [req.params.id]
    );
    await client.query('COMMIT');

    await auditLog({
      actor: req.user, action: 'platform.reseller.delete',
      targetType: 'reseller', targetId: req.params.id,
      payload: { ip: clientIp(req), name: found[0].name, disabledLogins: disabled },
    });
    res.json({ ok: true, disabledLogins: disabled });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[platform] delete reseller error:', err.message);
    res.status(500).json({ error: 'Failed to delete partner' });
  } finally {
    client.release();
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
