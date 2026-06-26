// Billing / entitlements (read-only) for the current tenant.
//
// Powers the frontend's feature-gating UX: which features the tenant's plan
// includes, current usage vs limits, and the catalog of plans for upsell. Plan
// CHANGES are made by a super admin via the platform API (no self-serve checkout
// yet), so this surface is read-only.

const { Router } = require('express');
const pool = require('../db');
const { getTenantEntitlement, getTenantFeatures, checkLimit } = require('../services/entitlements');

const router = Router();

// GET /api/billing/entitlements
router.get('/billing/entitlements', async (req, res) => {
  try {
    // Always return the plan catalog so the UI can render a comparison.
    const { rows: plans } = await pool.query(`
      SELECT p.key, p.name, p.description, p.price_monthly, p.price_yearly, p.currency,
             p.max_users, p.max_organizations, p.max_contacts, p.position,
             COALESCE(
               (SELECT json_agg(f.key ORDER BY f.key)
                  FROM coexistence.plan_features pf
                  JOIN coexistence.features f ON f.id = pf.feature_id
                 WHERE pf.plan_id = p.id), '[]'
             ) AS features
        FROM coexistence.plans p
       WHERE p.is_active = TRUE
       ORDER BY p.position, p.id
    `);
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

module.exports = router;
