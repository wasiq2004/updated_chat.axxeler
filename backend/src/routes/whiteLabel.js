// White-label public surface.
//
// On a shared domain, a partner's customers reach a branded login via
// ?w=<reseller-slug>. This PUBLIC endpoint returns just enough branding to theme
// the login screen BEFORE anyone authenticates. After login, branding comes from
// the user's reseller (see routes/billing.js entitlements).

const { Router } = require('express');
const pool = require('../db');

const publicRouter = Router();

publicRouter.get('/branding/by-slug/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT name, branding FROM coexistence.resellers
        WHERE slug = $1 AND status = 'active' AND deleted_at IS NULL`,
      [String(req.params.slug || '').toLowerCase()]
    );
    if (!rows.length) return res.json({ found: false });
    const b = rows[0].branding || {};
    res.json({
      found: true,
      brandName: typeof b.brandName === 'string' && b.brandName ? b.brandName : rows[0].name,
      primaryColor: /^#[0-9a-fA-F]{6}$/.test(b.primaryColor || '') ? b.primaryColor : null,
      logoUrl: typeof b.logoUrl === 'string' ? b.logoUrl : null,
      loginTagline: typeof b.loginTagline === 'string' ? b.loginTagline : null,
    });
  } catch (err) {
    console.error('[white-label] branding by slug error:', err.message);
    res.status(500).json({ error: 'Failed to load branding' });
  }
});

module.exports = { publicRouter };
