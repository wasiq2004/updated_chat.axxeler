// Public, unauthenticated runtime config the browser needs BEFORE login — e.g.
// the Facebook JS SDK app id + Embedded Signup config id so the "Login with
// Facebook" / "Sign in with Facebook" buttons can initialise, and the plan
// catalog the signup screen offers. Only non-secret values are exposed here
// (never FB_APP_SECRET). Mounted before authMiddleware.

const { Router } = require('express');
const pool = require('../db');
const facebookAuth = require('../services/facebookAuth');
const { verificationRequired } = require('../services/emailVerification');

const router = Router();

router.get('/public-config', (req, res) => {
  res.json({
    facebook: facebookAuth.getPublicConfig(),
    // Lets the signup form tell the person "check your inbox" instead of
    // sending them to a login that would reject them — and skip that screen
    // entirely on installs with no mailer.
    emailVerification: verificationRequired(),
  });
});

// GET /api/public-plans?w=<partner-slug> — the catalog to show on the signup
// screen, before anyone has an account. Scoped: a visitor arriving on a
// partner's link sees that partner's plans and prices, never ours or another
// partner's. An unknown/inactive slug falls back to the platform catalog, which
// matches how signup itself treats a bad slug (platform-direct, not rejected).
//
// Public on purpose: these are the prices already published on the pricing page.
// Nothing here is per-tenant.
router.get('/public-plans', async (req, res) => {
  try {
    let resellerId = null;
    const slug = String(req.query.w || '').trim().toLowerCase();
    if (slug) {
      const { rows } = await pool.query(
        `SELECT id FROM coexistence.resellers
          WHERE slug = $1 AND status = 'active' AND deleted_at IS NULL`,
        [slug]
      );
      resellerId = rows[0]?.id ?? null;
    }
    const { rows: plans } = await pool.query(
      `SELECT p.key, p.name, p.description, p.price_monthly, p.price_yearly, p.currency,
              p.max_users, p.max_organizations, p.max_contacts, p.position,
              COALESCE(
                (SELECT json_agg(f.key ORDER BY f.key)
                   FROM coexistence.plan_features pf
                   JOIN coexistence.features f ON f.id = pf.feature_id
                  WHERE pf.plan_id = p.id), '[]'
              ) AS features
         FROM coexistence.plans p
        WHERE p.is_active = TRUE AND p.reseller_id IS NOT DISTINCT FROM $1
        ORDER BY p.position, p.id`,
      [resellerId]
    );
    // A partner with no catalog of their own would otherwise show an empty
    // pricing table; fall back to the platform plans they resell.
    if (!plans.length && resellerId != null) {
      const { rows: fallback } = await pool.query(
        `SELECT key, name, description, price_monthly, price_yearly, currency,
                max_users, max_organizations, max_contacts, position, '[]'::json AS features
           FROM coexistence.plans
          WHERE is_active = TRUE AND reseller_id IS NULL
          ORDER BY position, id`
      );
      return res.json({ plans: fallback });
    }
    res.json({ plans });
  } catch (err) {
    console.error('[public-plans] error:', err.message);
    res.status(500).json({ error: 'Failed to load plans' });
  }
});

module.exports = { router };
