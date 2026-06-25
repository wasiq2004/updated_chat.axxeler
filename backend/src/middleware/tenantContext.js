// Tenant-context middleware (SaaS Phase 1).
//
// Runs AFTER authMiddleware (so req.user is set). It resolves the tenant and
// active organization for the request and attaches them to `req`:
//
//   req.tenantId        – the tenant the request operates in
//   req.organizationId  – the active organization (from X-Organization-Id,
//                         validated against the user's roles; else a default)
//   req.isSuperAdmin    – true for platform super admins (no tenant)
//   req.tenant          – { id }  (room to grow: status/plan/branding later)
//
// Phase 1 is NON-BLOCKING: it only attaches context and always calls next().
// Read/write queries are not yet forced through it (see ARCHITECTURE.md Phase 2),
// so a resolution miss can never break the currently-working app. Enforcement
// (requirePerm / featureGate / NOT NULL) lands once write paths set these.

const pool = require('../db');

// Super admins may target a specific tenant/org via headers; everyone else is
// pinned to their own tenant. Header names are case-insensitive in Express.
const H_ORG = 'x-organization-id';
const H_TENANT = 'x-tenant-id';

async function tenantContext(req, _res, next) {
  // Defensive: if there's no authenticated user, there's nothing to resolve.
  if (!req.user?.id) return next();

  try {
    // One round-trip: the user's tenant + whether they hold the super_admin role.
    const { rows } = await pool.query(
      `SELECT u.tenant_id, u.reseller_id,
              EXISTS (
                SELECT 1 FROM coexistence.user_roles ur
                  JOIN coexistence.roles r ON r.id = ur.role_id
                 WHERE ur.user_id = u.id AND r.key = 'super_admin'
              ) AS is_super_admin,
              EXISTS (
                SELECT 1 FROM coexistence.user_roles ur
                  JOIN coexistence.roles r ON r.id = ur.role_id
                 WHERE ur.user_id = u.id AND r.key = 'reseller_admin'
              ) AS is_reseller_admin
         FROM coexistence.z_chat_users u
        WHERE u.id = $1`,
      [req.user.id]
    );
    const row = rows[0] || {};
    req.isSuperAdmin = row.is_super_admin === true;
    // White-label partner operator: scoped platform owner over their own admins.
    // The platform API filters every tenant/plan/stat read by req.resellerId.
    req.isResellerAdmin = row.is_reseller_admin === true;
    req.resellerId = row.reseller_id ?? null;

    // Resolve the operating tenant. Super admins may impersonate a tenant via
    // X-Tenant-Id; otherwise the user is pinned to their own tenant.
    let tenantId = row.tenant_id ?? null;
    if (req.isSuperAdmin && req.headers[H_TENANT]) {
      const requested = Number(req.headers[H_TENANT]);
      if (Number.isInteger(requested) && requested > 0) tenantId = requested;
    }
    req.tenantId = tenantId;
    req.tenant = tenantId ? { id: tenantId } : null;

    // Resolve the active organization within that tenant. `explicit` is true
    // only when the client deliberately selected an org via X-Organization-Id
    // (the org switcher) — used to org-filter reads. Without it ("All orgs"),
    // tenant-wide data is shown.
    const org = await resolveOrganization(req, tenantId);
    req.organizationId = org.id;
    req.orgExplicit = org.explicit;
    return next();
  } catch (err) {
    // Never break the request in phase 1 — log and continue without context.
    console.error('[tenant] context resolution failed:', err.message);
    return next();
  }
}

// Pick the organization the request acts in:
//   1. X-Organization-Id header, if the user actually has access to it.
//   2. The first org the user holds an org-scoped role in (within the tenant).
//   3. The tenant's first organization (for tenant-wide roles / admins).
async function resolveOrganization(req, tenantId) {
  if (!tenantId) return { id: null, explicit: false };
  const userId = req.user.id;

  const requestedRaw = req.headers[H_ORG];
  const requested = requestedRaw != null ? Number(requestedRaw) : null;

  // Super admins aren't constrained by membership — honor the header directly.
  if (req.isSuperAdmin && Number.isInteger(requested) && requested > 0) {
    return { id: requested, explicit: true };
  }

  if (Number.isInteger(requested) && requested > 0) {
    const { rows } = await pool.query(
      `SELECT 1
         FROM coexistence.organizations o
        WHERE o.id = $1 AND o.tenant_id = $2 AND o.deleted_at IS NULL
          AND (
            EXISTS (
              SELECT 1 FROM coexistence.user_roles ur
               WHERE ur.user_id = $3
                 AND (ur.organization_id = o.id OR ur.organization_id IS NULL)
            )
          )
        LIMIT 1`,
      [requested, tenantId, userId]
    );
    if (rows.length) return { id: requested, explicit: true };
  }

  // Fall back to an org the user can see (NOT explicit → reads stay tenant-wide).
  const { rows } = await pool.query(
    `SELECT o.id
       FROM coexistence.organizations o
      WHERE o.tenant_id = $1 AND o.deleted_at IS NULL
        AND (
          EXISTS (
            SELECT 1 FROM coexistence.user_roles ur
             WHERE ur.user_id = $2
               AND (ur.organization_id = o.id OR ur.organization_id IS NULL)
          )
        )
      ORDER BY o.id ASC
      LIMIT 1`,
    [tenantId, userId]
  );
  return { id: rows[0]?.id ?? null, explicit: false };
}

module.exports = { tenantContext };
