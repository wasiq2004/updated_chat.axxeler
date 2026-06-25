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

    // Super admins (no tenant) get everything — they operate the platform.
    if (req.isSuperAdmin || req.tenantId == null) {
      return res.json({
        isSuperAdmin: !!req.isSuperAdmin,
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
    const branding = tRows[0]?.branding || {};
    const [users, orgs, contacts] = await Promise.all([
      checkLimit(req.tenantId, 'max_users'),
      checkLimit(req.tenantId, 'max_organizations'),
      checkLimit(req.tenantId, 'max_contacts'),
    ]);

    res.json({
      isSuperAdmin: false,
      tenantName: tRows[0]?.name || null,
      branding: {
        brandName: typeof branding.brandName === 'string' ? branding.brandName : null,
        primaryColor: /^#[0-9a-fA-F]{6}$/.test(branding.primaryColor || '') ? branding.primaryColor : null,
        logoUrl: typeof branding.logoUrl === 'string' ? branding.logoUrl : null,
      },
      plan: ent ? { key: ent.planKey } : null,
      status: ent?.status || null,
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
