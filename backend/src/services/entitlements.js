// Entitlements: plan features & limits (SaaS Phase 4 core).
//
// Resolves what a tenant is allowed to do from its active subscription's plan,
// applying per-subscription JSON overrides:
//   feature_overrides : { "<feature_key>": true | false }   (force on/off)
//   limit_overrides   : { "max_users": 50, ... }            (override plan limit)
//
// A NULL limit means "unlimited". These helpers are pure reads and safe to call
// anywhere; the `featureGate` middleware is opt-in per route.

const db = require('./../db');

// Grace window (days) a tenant keeps features after the plan's period end before
// they hard-lock. Configurable via PLAN_GRACE_DAYS (0 = lock immediately).
const GRACE_DAYS = (() => {
  const n = parseInt(process.env.PLAN_GRACE_DAYS ?? '3', 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();
const DAY_MS = 24 * 60 * 60 * 1000;

// Returns the tenant's entitlement with billing-period awareness, or null when
// there is no live subscription at all. The returned object includes:
//   periodEnd   : Date|null  (null = no expiry, e.g. the bootstrap Enterprise tenant)
//   expired     : period end is in the past
//   inGrace     : expired but still inside the grace window (features stay on)
//   locked      : grace exhausted → features must be denied
//   graceEndsAt : Date|null
//   daysLeft    : whole days until lock (negative once locked); null if no expiry
async function getTenantEntitlement(tenantId) {
  if (!tenantId) return null;
  const { rows } = await db.query(
    `SELECT s.plan_id, p.key AS plan_key, s.status,
            s.feature_overrides, s.limit_overrides, s.current_period_end,
            p.max_users, p.max_organizations, p.max_contacts
       FROM coexistence.subscriptions s
       JOIN coexistence.plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1 AND s.status IN ('active','trialing','past_due')
      ORDER BY s.id DESC
      LIMIT 1`,
    [tenantId]
  );
  const r = rows[0];
  if (!r) return null;

  const now = Date.now();
  const periodEnd = r.current_period_end ? new Date(r.current_period_end) : null;
  const expired = periodEnd != null && now > periodEnd.getTime();
  const graceEndsAt = periodEnd ? new Date(periodEnd.getTime() + GRACE_DAYS * DAY_MS) : null;
  const locked = graceEndsAt != null && now > graceEndsAt.getTime();
  const inGrace = expired && !locked;
  const daysLeft = graceEndsAt ? Math.ceil((graceEndsAt.getTime() - now) / DAY_MS) : null;

  return {
    planId: r.plan_id,
    planKey: r.plan_key,
    status: r.status,
    featureOverrides: r.feature_overrides || {},
    limitOverrides: r.limit_overrides || {},
    planLimits: {
      max_users: r.max_users,
      max_organizations: r.max_organizations,
      max_contacts: r.max_contacts,
    },
    periodEnd,
    graceEndsAt,
    expired,
    inGrace,
    locked,
    daysLeft,
  };
}

// Does the tenant's plan (± overrides) include a feature?
async function tenantHasFeature(tenantId, featureKey) {
  const ent = await getTenantEntitlement(tenantId);
  if (!ent) return false;
  if (ent.locked) return false; // expired past the grace window → everything off
  if (Object.prototype.hasOwnProperty.call(ent.featureOverrides, featureKey)) {
    return ent.featureOverrides[featureKey] === true;
  }
  const { rows } = await db.query(
    `SELECT 1
       FROM coexistence.plan_features pf
       JOIN coexistence.features f ON f.id = pf.feature_id
      WHERE pf.plan_id = $1 AND f.key = $2
      LIMIT 1`,
    [ent.planId, featureKey]
  );
  return rows.length > 0;
}

// Effective numeric limit for a kind ('max_users'|'max_organizations'|'max_contacts').
// Returns null for unlimited, or a number.
async function getLimit(tenantId, kind) {
  const ent = await getTenantEntitlement(tenantId);
  if (!ent) return 0; // no active plan → nothing allowed
  if (ent.locked) return 0; // expired past grace → cannot add more of anything
  if (Object.prototype.hasOwnProperty.call(ent.limitOverrides, kind)) {
    const v = ent.limitOverrides[kind];
    return v == null ? null : Number(v);
  }
  return ent.planLimits[kind]; // may be null (unlimited)
}

// Current usage counters for a tenant.
async function getUsage(tenantId, kind) {
  const sql = {
    max_users:
      `SELECT COUNT(*)::int AS n FROM coexistence.z_chat_users WHERE tenant_id = $1`,
    max_organizations:
      `SELECT COUNT(*)::int AS n FROM coexistence.organizations WHERE tenant_id = $1 AND deleted_at IS NULL`,
    max_contacts:
      `SELECT COUNT(*)::int AS n FROM coexistence.contacts WHERE tenant_id = $1`,
  }[kind];
  if (!sql) return 0;
  const { rows } = await db.query(sql, [tenantId]);
  return rows[0]?.n ?? 0;
}

// { allowed, used, max } — allowed=true when max is null (unlimited) or used < max.
async function checkLimit(tenantId, kind) {
  const max = await getLimit(tenantId, kind);
  if (max == null) return { allowed: true, used: null, max: null };
  const used = await getUsage(tenantId, kind);
  return { allowed: used < max, used, max };
}

// The set of feature keys a tenant has (plan features ± per-subscription overrides).
async function getTenantFeatures(tenantId) {
  const ent = await getTenantEntitlement(tenantId);
  if (!ent) return [];
  if (ent.locked) return []; // expired past grace → no features
  const { rows } = await db.query(
    `SELECT f.key FROM coexistence.plan_features pf
       JOIN coexistence.features f ON f.id = pf.feature_id
      WHERE pf.plan_id = $1`,
    [ent.planId]
  );
  const keys = new Set(rows.map(r => r.key));
  for (const [k, v] of Object.entries(ent.featureOverrides || {})) {
    if (v === true) keys.add(k); else keys.delete(k);
  }
  return [...keys];
}

// Express middleware: 403 when the tenant's plan lacks `featureKey`.
// Super admins bypass. Opt-in per route (not applied globally).
function featureGate(featureKey) {
  return async (req, res, next) => {
    try {
      if (req.isSuperAdmin === true) return next();
      if (await tenantHasFeature(req.tenantId, featureKey)) return next();
      return res.status(403).json({
        error: 'This feature is not included in your plan.',
        requiredFeature: featureKey,
      });
    } catch (err) {
      console.error('[entitlements] featureGate error:', err.message);
      // Fail CLOSED: this gate is the only enforcement of plan/expiry on premium
      // routes, so on an entitlement-lookup error we deny rather than silently
      // grant a feature the tenant may not be entitled to. Super admins already
      // short-circuited above, so this never blocks platform operators.
      return res.status(503).json({ error: 'Could not verify your plan entitlements. Please try again.' });
    }
  };
}

module.exports = {
  getTenantEntitlement,
  getTenantFeatures,
  tenantHasFeature,
  getLimit,
  getUsage,
  checkLimit,
  featureGate,
};
