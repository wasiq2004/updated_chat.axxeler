// DB-driven RBAC (SaaS Phase 1).
//
// Effective permissions for a user in an organization = the union of every
// permission attached (via role_permissions) to the roles the user holds whose
// scope matches the active organization. A role row with organization_id NULL is
// tenant-wide and applies in every organization.
//
// Super admins short-circuit to allow-all. This module is the replacement for
// the legacy page-string gate in permissions.js; routes are migrated onto
// `requirePerm()` incrementally (ARCHITECTURE.md, Phase 2). Until a route is
// migrated, nothing here changes its behavior.

const db = require('./db'); // backend/src/db.js — shared pg pool

// Returns a Set<string> of permission keys the user has in the given org.
// organizationId may be null (tenant-wide context) — only NULL-scoped roles apply.
async function getUserPermissions(userId, organizationId = null) {
  const { rows } = await db.query(
    `SELECT DISTINCT p.key
       FROM coexistence.user_roles ur
       JOIN coexistence.role_permissions rp ON rp.role_id = ur.role_id
       JOIN coexistence.permissions p       ON p.id = rp.permission_id
      WHERE ur.user_id = $1
        AND (ur.organization_id IS NULL OR ur.organization_id = $2)`,
    [userId, organizationId]
  );
  return new Set(rows.map(r => r.key));
}

// Does the user hold `permissionKey` in the given org? Super admin always true.
async function userHasPermission(userId, organizationId, permissionKey) {
  if (await isSuperAdmin(userId)) return true;
  const { rows } = await db.query(
    `SELECT 1
       FROM coexistence.user_roles ur
       JOIN coexistence.role_permissions rp ON rp.role_id = ur.role_id
       JOIN coexistence.permissions p       ON p.id = rp.permission_id
      WHERE ur.user_id = $1
        AND p.key = $2
        AND (ur.organization_id IS NULL OR ur.organization_id = $3)
      LIMIT 1`,
    [userId, permissionKey, organizationId]
  );
  return rows.length > 0;
}

async function isSuperAdmin(userId) {
  const { rows } = await db.query(
    `SELECT 1
       FROM coexistence.user_roles ur
       JOIN coexistence.roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND r.key = 'super_admin'
      LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

// Express middleware factory. Gates a route on a single permission key against
// the request's active organization (set by tenantContext). Prefers req.isSuperAdmin
// when tenantContext has already resolved it, to avoid an extra query.
//
//   router.post('/contacts', requirePerm('contacts.create'), handler)
//
// NOT yet applied to existing routes — available for new/migrated routes.
function requirePerm(permissionKey) {
  return async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
      if (req.isSuperAdmin === true) return next();
      const ok = await userHasPermission(req.user.id, req.organizationId ?? null, permissionKey);
      if (!ok) return res.status(403).json({ error: 'Forbidden', requiredPermission: permissionKey });
      return next();
    } catch (err) {
      console.error('[rbac] requirePerm error:', err.message);
      return res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

// Express middleware: allow only platform super admins. Prefers the flag
// resolved by tenantContext; falls back to a direct check.
async function requireSuperAdmin(req, res, next) {
  try {
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    if (req.isSuperAdmin === true) return next();
    if (await isSuperAdmin(req.user.id)) return next();
    return res.status(403).json({ error: 'Super admin access required' });
  } catch (err) {
    console.error('[rbac] requireSuperAdmin error:', err.message);
    return res.status(500).json({ error: 'Permission check failed' });
  }
}

module.exports = {
  getUserPermissions,
  userHasPermission,
  isSuperAdmin,
  requirePerm,
  requireSuperAdmin,
};
