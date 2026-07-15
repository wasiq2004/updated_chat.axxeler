// Billing / entitlements for the current tenant.
//
// Powers the frontend's feature-gating UX: which features the tenant's plan
// includes, current usage vs limits, and the catalog of plans for upsell.
//
// There is still no payment gateway. A tenant admin cannot change their own plan
// directly — they file a plan REQUEST (POST /billing/plan-request), which an
// operator approves once payment has been collected out of band. That keeps the
// money path manual while giving the customer a real "buy" action.

const { Router } = require('express');
const pool = require('../db');
const { isAdmin } = require('../permissions');
const { auditLog } = require('../middleware/access');
const { getTenantEntitlement, getTenantFeatures, checkLimit } = require('../services/entitlements');

const router = Router();

// The plan catalog belongs to whoever owns the customer: a partner's tenant sees
// ONLY that partner's plans, a platform-direct tenant sees only platform plans.
// (Before this was scoped, every tenant could see every partner's private
// catalog — including their pricing.)
async function catalogFor(resellerId) {
  const { rows } = await pool.query(`
    SELECT p.key, p.name, p.description, p.price_monthly, p.price_yearly, p.currency,
           p.max_users, p.max_organizations, p.max_contacts, p.position,
           COALESCE(
             (SELECT json_agg(f.key ORDER BY f.key)
                FROM coexistence.plan_features pf
                JOIN coexistence.features f ON f.id = pf.feature_id
               WHERE pf.plan_id = p.id), '[]'
           ) AS features
      FROM coexistence.plans p
     WHERE p.is_active = TRUE AND p.reseller_id IS NOT DISTINCT FROM $1
     ORDER BY p.position, p.id
  `, [resellerId]);
  return rows;
}

// Which catalog does this tenant buy from? NULL = platform-direct.
async function resellerOfTenant(tenantId) {
  if (tenantId == null) return null;
  const { rows } = await pool.query('SELECT reseller_id FROM coexistence.tenants WHERE id = $1', [tenantId]);
  return rows[0]?.reseller_id ?? null;
}

// GET /api/billing/entitlements
router.get('/billing/entitlements', async (req, res) => {
  try {
    // A console user (super admin / partner admin) has no tenant of their own;
    // show them the catalog they administer.
    const catalogOwner = req.tenantId == null
      ? (req.isSuperAdmin ? null : req.resellerId ?? null)
      : await resellerOfTenant(req.tenantId);
    const plans = await catalogFor(catalogOwner);
    const { rows: allFeatures } = await pool.query(
      'SELECT key, name, description FROM coexistence.features ORDER BY key'
    );

    // Super admins + reseller (partner) admins have no tenant. They get all
    // features; a reseller admin additionally gets THEIR OWN partner branding so
    // their console is never shown under our name.
    if (req.isSuperAdmin || req.tenantId == null) {
      let branding = null;
      if (!req.isSuperAdmin && req.resellerId != null) {
        const { rows: rRows } = await pool.query(
          `SELECT name, branding FROM coexistence.resellers WHERE id = $1 AND deleted_at IS NULL`,
          [req.resellerId]
        );
        if (rRows.length) {
          const b = rRows[0].branding || {};
          branding = {
            // Fall back to the partner's NAME (never our "Zen Chat") until they set one.
            brandName: (typeof b.brandName === 'string' && b.brandName) ? b.brandName : rRows[0].name,
            primaryColor: /^#[0-9a-fA-F]{6}$/.test(b.primaryColor || '') ? b.primaryColor : null,
            logoUrl: (typeof b.logoUrl === 'string' && b.logoUrl) ? b.logoUrl : null,
            isCustom: true,
          };
        }
      }
      return res.json({
        isSuperAdmin: !!req.isSuperAdmin,
        branding,
        plan: null,
        status: null,
        features: allFeatures.map(f => f.key), // treat as all-access
        limits: {},
        catalog: { plans, features: allFeatures },
      });
    }

    const ent = await getTenantEntitlement(req.tenantId);
    const features = await getTenantFeatures(req.tenantId);
    const { rows: tRows } = await pool.query(
      'SELECT name, branding FROM coexistence.tenants WHERE id = $1', [req.tenantId]
    );
    // White-label: if this tenant belongs to a reseller (partner), the RESELLER's
    // branding is the platform identity the user sees — it takes precedence over
    // the tenant's own branding.
    const { rows: rbRows } = await pool.query(
      `SELECT r.branding, r.name FROM coexistence.resellers r
         JOIN coexistence.tenants t ON t.reseller_id = r.id
        WHERE t.id = $1 AND r.status = 'active' AND r.deleted_at IS NULL`,
      [req.tenantId]
    );
    const fromReseller = rbRows.length > 0;
    const branding = rbRows[0]?.branding || tRows[0]?.branding || {};
    // A partner-scoped tenant (or a tenant that set its own brand) must never show
    // OUR "Zen Chat" identity: fall back to the partner's name and mark it custom
    // so the frontend renders the name instead of our default logo.
    const resolvedBrandName = (typeof branding.brandName === 'string' && branding.brandName)
      ? branding.brandName
      : (fromReseller ? (rbRows[0].name || null) : null);
    const isCustomBrand = fromReseller || !!resolvedBrandName;
    const [users, orgs, contacts] = await Promise.all([
      checkLimit(req.tenantId, 'max_users'),
      checkLimit(req.tenantId, 'max_organizations'),
      checkLimit(req.tenantId, 'max_contacts'),
    ]);

    res.json({
      isSuperAdmin: false,
      tenantName: tRows[0]?.name || null,
      branding: {
        brandName: resolvedBrandName,
        primaryColor: /^#[0-9a-fA-F]{6}$/.test(branding.primaryColor || '') ? branding.primaryColor : null,
        logoUrl: typeof branding.logoUrl === 'string' ? branding.logoUrl : null,
        isCustom: isCustomBrand,
      },
      // When the tenant is under a white-label reseller, the reseller's branding
      // wins — so the tenant's own BrandingPage is read-only / hidden.
      brandingManagedByReseller: rbRows.length > 0,
      plan: ent ? { key: ent.planKey } : null,
      status: ent?.status || null,
      // Billing-period state drives the grace-warning banner and the locked
      // "renew" screen on the frontend.
      subscription: ent ? {
        status: ent.status,
        periodEnd: ent.periodEnd,
        graceEndsAt: ent.graceEndsAt,
        expired: ent.expired,
        inGrace: ent.inGrace,
        locked: ent.locked,
        daysLeft: ent.daysLeft,
      } : { status: null, locked: false, inGrace: false, expired: false },
      features,
      limits: {
        users: { used: users.used, max: users.max },
        organizations: { used: orgs.used, max: orgs.max },
        contacts: { used: contacts.used, max: contacts.max },
      },
      catalog: { plans, features: allFeatures },
    });
  } catch (err) {
    console.error('[billing] entitlements error:', err.message);
    res.status(500).json({ error: 'Failed to load entitlements' });
  }
});

// ---------------------------------------------------------------------------
// Plan requests — the "purchase" step, pending a payment gateway.
// ---------------------------------------------------------------------------

function shapeRequest(r) {
  return {
    id: r.id,
    planKey: r.plan_key,
    planName: r.plan_name,
    priceMonthly: r.price_monthly,
    priceYearly: r.price_yearly,
    currency: r.currency,
    billingCycle: r.billing_cycle,
    status: r.status,
    note: r.note,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

// GET /api/billing/plan-request — the tenant's live request, if any. Drives the
// "Upgrade requested — we'll be in touch" state on the billing page.
router.get('/billing/plan-request', async (req, res) => {
  if (req.tenantId == null) return res.json({ request: null });
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, p.key AS plan_key, p.name AS plan_name, p.price_monthly, p.price_yearly, p.currency
         FROM coexistence.plan_requests pr
         JOIN coexistence.plans p ON p.id = pr.plan_id
        WHERE pr.tenant_id = $1 AND pr.status = 'pending'
        ORDER BY pr.id DESC LIMIT 1`,
      [req.tenantId]
    );
    res.json({ request: rows.length ? shapeRequest(rows[0]) : null });
  } catch (err) {
    console.error('[billing] plan-request read error:', err.message);
    res.status(500).json({ error: 'Failed to load plan request' });
  }
});

// POST /api/billing/plan-request — Body: { planKey, billingCycle, note }.
// Records intent to buy. Idempotent per tenant: re-requesting replaces the
// pending row rather than queueing duplicates (idx_plan_requests_one_pending).
router.post('/billing/plan-request', async (req, res) => {
  if (req.tenantId == null) return res.status(400).json({ error: 'No workspace on this account' });
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only a workspace admin can change the plan' });
  const { planKey, billingCycle = 'monthly', note } = req.body || {};
  if (!planKey) return res.status(400).json({ error: 'planKey is required' });
  const cycle = billingCycle === 'yearly' ? 'yearly' : 'monthly';
  const client = await pool.connect();
  try {
    // The plan must come from THIS tenant's catalog — a tenant must not be able
    // to request another partner's plan by guessing its key.
    const rid = await resellerOfTenant(req.tenantId);
    const { rows: planRows } = await client.query(
      `SELECT id, key, name FROM coexistence.plans
        WHERE key = $1 AND is_active AND reseller_id IS NOT DISTINCT FROM $2`,
      [planKey, rid]
    );
    if (!planRows.length) return res.status(400).json({ error: `Unknown plan '${planKey}'` });

    await client.query('BEGIN');
    await client.query(
      `UPDATE coexistence.plan_requests SET status = 'cancelled', updated_at = NOW()
        WHERE tenant_id = $1 AND status = 'pending'`,
      [req.tenantId]
    );
    const { rows } = await client.query(
      `INSERT INTO coexistence.plan_requests (tenant_id, plan_id, billing_cycle, note, requested_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [req.tenantId, planRows[0].id, cycle, note ? String(note).slice(0, 500) : null, req.user.id]
    );
    await client.query('COMMIT');

    await auditLog({
      actor: req.user, action: 'billing.plan_request', targetType: 'tenant',
      targetId: req.tenantId, payload: { planKey, billingCycle: cycle }, from: req,
    });
    res.status(201).json({
      id: rows[0].id, planKey: planRows[0].key, planName: planRows[0].name,
      billingCycle: cycle, status: 'pending', createdAt: rows[0].created_at,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[billing] plan-request error:', err.message);
    res.status(500).json({ error: 'Failed to submit plan request' });
  } finally {
    client.release();
  }
});

// DELETE /api/billing/plan-request — withdraw a pending request.
router.delete('/billing/plan-request', async (req, res) => {
  if (req.tenantId == null) return res.status(400).json({ error: 'No workspace on this account' });
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only a workspace admin can change the plan' });
  try {
    await pool.query(
      `UPDATE coexistence.plan_requests SET status = 'cancelled', updated_at = NOW()
        WHERE tenant_id = $1 AND status = 'pending'`,
      [req.tenantId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[billing] cancel plan-request error:', err.message);
    res.status(500).json({ error: 'Failed to cancel request' });
  }
});

module.exports = router;
