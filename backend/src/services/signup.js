// Self-serve signup: create a workspace (tenant + organization + owner user +
// subscription) for someone who arrived on their own, with no operator above
// them.
//
// This mirrors the operator-driven POST /platform/tenants transaction
// (routes/platform.js) on purpose — same table order, same role wiring — but
// differs in three ways that matter:
//
//   * created_by is NULL (nullable FK): there is no actor.
//   * username and tenants.slug are BOTH globally unique and must be derived,
//     not supplied. The first-run wizard hardcodes username 'admin', which would
//     collide on the second signup.
//   * the plan comes from the partner's catalog when the visitor arrived via
//     ?w=<slug>, so a white-label customer never lands on a platform plan.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const RESERVED = new Set(['admin', 'root', 'system', 'support', 'default', 'api', 'www', 'app']);

// Derive a slug-safe base from arbitrary text. Returns '' when nothing survives
// (e.g. an all-emoji company name) — callers supply their own fallback.
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function usernameBase(email) {
  const local = String(email || '').split('@')[0];
  const cleaned = local.toLowerCase().replace(/[^a-z0-9._-]+/g, '').replace(/^[._-]+|[._-]+$/g, '').slice(0, 24);
  return cleaned.length >= 3 && !RESERVED.has(cleaned) ? cleaned : `user${crypto.randomInt(1000, 9999)}`;
}

function suffix() {
  return crypto.randomInt(100, 999999).toString(36);
}

// Find a value not already taken. `column` is interpolated into SQL, so it is
// never caller-controlled — both call sites pass a literal below.
async function findFree(client, table, column, base, fallback) {
  let candidate = base || fallback;
  for (let i = 0; i < 12; i++) {
    const { rows } = await client.query(
      `SELECT 1 FROM coexistence.${table} WHERE ${column} = $1 LIMIT 1`,
      [candidate]
    );
    if (!rows.length && !RESERVED.has(candidate)) return candidate;
    candidate = `${(base || fallback).slice(0, 24)}-${suffix()}`;
  }
  // 12 collisions on a random suffix is effectively impossible; if it happens,
  // fail loudly rather than insert something that violates the unique index.
  throw new Error(`Could not allocate a unique ${table}.${column}`);
}

// Resolve ?w=<slug> to a partner.
//
// Returns { id } for a live partner, null for an unknown slug (the visitor is
// simply platform-direct — a typo shouldn't reject them), or { blocked: true }
// when the slug names a REAL partner who is suspended or deleted.
//
// That distinction matters commercially. Treating suspended the same as unknown
// meant the partner's own prospect, arriving on the partner's own link, silently
// became the platform owner's customer with the platform's plans — and there is
// no un-assign. Suspension is a temporary billing lever; it must not double as
// lead confiscation. We refuse the signup instead.
async function resolveReseller(client, slug) {
  if (!slug) return null;
  const { rows } = await client.query(
    `SELECT id, status, deleted_at FROM coexistence.resellers WHERE slug = $1`,
    [String(slug).toLowerCase()]
  );
  if (!rows.length) return null;
  const r = rows[0];
  if (r.deleted_at != null || r.status !== 'active') return { blocked: true };
  return { id: r.id };
}

// Back-compat helper: the id only, for callers that don't care why.
async function resolveResellerId(client, slug) {
  const r = await resolveReseller(client, slug);
  return r && !r.blocked ? r.id : null;
}

// The entry plan a brand-new workspace starts on, from whichever catalog owns
// this customer.
//
// 'enterprise' is EXCLUDED, not merely ranked last. The seeded enterprise plan is
// priced 0 (it means "Custom — call us") with unlimited seats and all 12
// features. Ordering by price alone therefore handed unlimited Enterprise, free
// and forever, to every signup under any catalog that had no plan keyed
// 'starter'. Price is not a safe proxy for "entry tier" while 0 is overloaded to
// mean both "free" and "POA".
//
// Order: an explicit 'starter' wins; else the operator's own ordering
// (position), then price. Returns null only if no plan exists anywhere.
const ENTRY_PLAN_ORDER = `ORDER BY (key = 'starter') DESC, position ASC, price_monthly ASC`;

async function pickStarterPlan(client, resellerId) {
  const { rows } = await client.query(
    `SELECT id FROM coexistence.plans
      WHERE reseller_id IS NOT DISTINCT FROM $1 AND is_active AND key <> 'enterprise'
      ${ENTRY_PLAN_ORDER}
      LIMIT 1`,
    [resellerId]
  );
  if (rows.length) return rows[0].id;
  if (resellerId == null) return null;
  // A partner with no usable catalog of their own falls back to the platform
  // entry plan rather than to their own Enterprise.
  const { rows: platform } = await client.query(
    `SELECT id FROM coexistence.plans
      WHERE reseller_id IS NULL AND is_active AND key <> 'enterprise'
      ${ENTRY_PLAN_ORDER}
      LIMIT 1`
  );
  return platform.length ? platform[0].id : null;
}

async function emailTaken(client, email) {
  const { rows } = await client.query(
    'SELECT 1 FROM coexistence.z_chat_users WHERE email = $1 LIMIT 1',
    [email]
  );
  return rows.length > 0;
}

/**
 * Create tenant + organization + owner + subscription. Must be called inside an
 * open transaction; the caller owns BEGIN/COMMIT so signup can bundle extra
 * work (e.g. issuing a verification token) into the same atomic unit.
 *
 * @returns {{ userId, tenantId, organizationId, planId, resellerId, username, slug }}
 */
async function createWorkspace(client, {
  email,
  password,          // null for Facebook signup — a random one is set instead
  displayName,
  companyName,
  partnerSlug = null,
  fbUserId = null,
  source = 'self_serve',
  acceptedTerms = false,
}) {
  const cleanEmail = String(email).trim().toLowerCase();
  const name = String(displayName || '').trim() || cleanEmail.split('@')[0];
  const company = String(companyName || '').trim() || `${name}'s workspace`;

  const partner = await resolveReseller(client, partnerSlug);
  if (partner?.blocked) {
    const err = new Error('Sign-ups are currently unavailable for this partner. Please contact them directly.');
    err.code = 'PARTNER_UNAVAILABLE';
    throw err;
  }
  const resellerId = partner?.id ?? null;
  const planId = await pickStarterPlan(client, resellerId);

  const username = await findFree(client, 'z_chat_users', 'username', usernameBase(cleanEmail), 'user');
  const slug = await findFree(client, 'tenants', 'slug', slugify(company), 'workspace');

  const { rows: tRows } = await client.query(
    `INSERT INTO coexistence.tenants (name, slug, status, plan_id, reseller_id)
     VALUES ($1, $2, 'active', $3, $4) RETURNING id`,
    [company.slice(0, 120), slug, planId, resellerId]
  );
  const tenantId = tRows[0].id;

  const { rows: oRows } = await client.query(
    `INSERT INTO coexistence.organizations (tenant_id, name, slug, status)
     VALUES ($1, 'Default', 'default', 'active') RETURNING id`,
    [tenantId]
  );
  const organizationId = oRows[0].id;

  if (planId) {
    // current_period_end is NULL for a FREE plan — "never expires", the same
    // convention the sweeper and the bootstrap tenant already use. Stamping a
    // period on a zero-price plan meant every free signup went past_due at day
    // 30 and lost all access at day 33: the funnel expired on a timer.
    await client.query(
      `INSERT INTO coexistence.subscriptions
         (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
       SELECT $1, $2, 'active', 'monthly', NOW(),
              CASE WHEN p.price_monthly = 0 THEN NULL ELSE NOW() + INTERVAL '1 month' END
         FROM coexistence.plans p WHERE p.id = $2`,
      [tenantId, planId]
    );
  }

  // A Facebook signup has no password. The column is NOT NULL, so store a hash
  // of random bytes: unguessable, and /auth/login can never match it (they sign
  // in with Facebook, or set a password later via reset).
  const raw = password || crypto.randomBytes(32).toString('base64url');
  const hash = await bcrypt.hash(raw, 10);

  // role='admin' (not the column default 'viewer'): this person owns the
  // workspace. 'viewer' only grants ['home','about'], so they could not work.
  //
  // password_set = FALSE for a Facebook signup: the stored hash is of random
  // bytes nobody has ever seen, so /auth/login can never match it. The flag is
  // what lets us offer "set a password" instead of stranding them if they ever
  // lose Facebook access.
  const { rows: uRows } = await client.query(
    `INSERT INTO coexistence.z_chat_users
       (username, email, password, display_name, role, tenant_id, reseller_id,
        fb_user_id, is_active, signup_source, password_set, terms_accepted_at)
     VALUES ($1, $2, $3, $4, 'admin', $5, NULL, $6, TRUE, $7, $8, $9)
     RETURNING id`,
    [
      username, cleanEmail, hash, name.slice(0, 120), tenantId, fbUserId, source,
      !!password,
      acceptedTerms ? new Date() : null,
    ]
  );
  const userId = uRows[0].id;

  // RBAC side of the dual-write. reseller_id stays NULL on the user: an ordinary
  // tenant user inherits their partner through tenants.reseller_id — only a
  // partner's own console admin carries reseller_id directly.
  await client.query(
    `INSERT INTO coexistence.user_roles (user_id, role_id, organization_id, created_by)
       SELECT $1, r.id, NULL, NULL FROM coexistence.roles r
        WHERE r.key = 'tenant_admin' AND r.tenant_id IS NULL
     ON CONFLICT DO NOTHING`,
    [userId]
  );

  await client.query(
    `UPDATE coexistence.tenants SET created_by = $1 WHERE id = $2`, [userId, tenantId]
  );
  await client.query(
    `UPDATE coexistence.organizations SET created_by = $1 WHERE id = $2`, [userId, organizationId]
  );

  return { userId, tenantId, organizationId, planId, resellerId, username, slug };
}

module.exports = {
  createWorkspace, emailTaken, resolveReseller, resolveResellerId, slugify, usernameBase,
};
