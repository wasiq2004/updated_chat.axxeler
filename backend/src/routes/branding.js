// White-label branding (SaaS Phase 6). A tenant can customize the product name,
// accent color and logo. GET is available to any tenant user (so the app can
// theme itself); PATCH requires settings.manage AND the white_label plan feature.

const { Router } = require('express');
const pool = require('../db');
const { requirePerm } = require('../rbac');
const { tenantHasFeature } = require('../services/entitlements');
const { auditLog } = require('../middleware/access');

const router = Router();

const HEX = /^#([0-9a-fA-F]{6})$/;

function shape(branding) {
  const b = branding || {};
  return {
    brandName: typeof b.brandName === 'string' ? b.brandName : null,
    primaryColor: HEX.test(b.primaryColor || '') ? b.primaryColor : null,
    logoUrl: typeof b.logoUrl === 'string' ? b.logoUrl : null,
  };
}

// GET /api/branding — the current tenant's branding (empty for super admins).
router.get('/branding', async (req, res) => {
  try {
    if (req.tenantId == null) return res.json(shape(null));
    const { rows } = await pool.query(
      'SELECT branding FROM coexistence.tenants WHERE id = $1', [req.tenantId]
    );
    res.json(shape(rows[0]?.branding));
  } catch (err) {
    console.error('[branding] get error:', err.message);
    res.status(500).json({ error: 'Failed to load branding' });
  }
});

// PATCH /api/branding — update branding. White-label feature + settings.manage.
router.patch('/branding', requirePerm('settings.manage'), async (req, res) => {
  try {
    if (req.tenantId == null) return res.status(400).json({ error: 'No tenant context' });
    if (!req.isSuperAdmin && !(await tenantHasFeature(req.tenantId, 'white_label'))) {
      return res.status(403).json({ error: 'White-label branding is not included in your plan.', requiredFeature: 'white_label' });
    }
    const { brandName, primaryColor, logoUrl } = req.body || {};
    if (primaryColor != null && primaryColor !== '' && !HEX.test(primaryColor)) {
      return res.status(400).json({ error: 'primaryColor must be a hex like #E22635' });
    }
    const next = shape({
      brandName: brandName != null ? String(brandName).slice(0, 60) : undefined,
      primaryColor: primaryColor || undefined,
      logoUrl: logoUrl != null ? String(logoUrl).slice(0, 500) : undefined,
    });
    const { rows } = await pool.query(
      `UPDATE coexistence.tenants SET branding = $1::jsonb, updated_at = NOW()
        WHERE id = $2 RETURNING branding`,
      [JSON.stringify(next), req.tenantId]
    );
    await auditLog({ actor: req.user, action: 'tenant.branding.update', targetType: 'tenant', targetId: req.tenantId, from: req, payload: next });
    res.json(shape(rows[0]?.branding));
  } catch (err) {
    console.error('[branding] update error:', err.message);
    res.status(500).json({ error: 'Failed to update branding' });
  }
});

module.exports = router;
