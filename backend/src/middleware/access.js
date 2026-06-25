// Role / permission enforcement and audit logging.
//
// The JWT only carries { id, username, displayName, role } — for permission
// checks against the optional per-user overrides we re-load the row.

const pool = require('../db');
const { isAdmin, hasPermission } = require('../permissions');

// adminOnly: simple gate on req.user.role
function adminOnly(req, res, next) {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// requirePermission(page): gates a route on whether the current user can
// reach `page`. Loads the user row fresh so per-user overrides are honoured.
function requirePermission(page) {
  return async (req, res, next) => {
    try {
      if (isAdmin(req.user)) return next();
      const { rows } = await pool.query(
        `SELECT role, permissions FROM coexistence.z_chat_users WHERE id = $1`,
        [req.user.id]
      );
      const u = rows[0];
      if (!u) return res.status(401).json({ error: 'User not found' });
      if (!hasPermission({ role: u.role, permissions: u.permissions }, page)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    } catch (err) {
      console.error('[access] requirePermission error:', err.message);
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

// Look up the WA numbers a user is allowed to see. Admin gets null
// (meaning "no scoping needed"). Non-admins get the array — may be empty.
async function userWaNumbers(userId) {
  const { rows } = await pool.query(
    `SELECT wa_number FROM coexistence.user_wa_assignments WHERE user_id = $1`,
    [userId]
  );
  return rows.map(r => r.wa_number);
}

// Build a SQL fragment + params to scope a query to "rows visible to req.user".
// Used by read endpoints (messages, contacts, numbers). The fragment is a
// boolean expression; the caller injects it into their WHERE.
//
//   const scope = await buildWaScope(req, '{table_alias}', paramIndex);
//   if (scope.sql) { whereClauses.push(scope.sql); params.push(...scope.params); }
//
// `tableAlias.wa_number` and `tableAlias.contact_number` must exist on the
// table being scoped (true for chat_history, contacts, and the derived
// messages/numbers/contact-names queries).
//
// Returns { sql, params }. `sql` is empty string when scoping is unnecessary
// (admin, or non-scopable route).
async function buildWaScope(req, tableAlias, startParamIndex) {
  if (isAdmin(req.user)) return { sql: '', params: [] };
  const waNumbers = await userWaNumbers(req.user.id);
  if (waNumbers.length === 0) {
    // BDA with no assignments → see nothing
    return { sql: 'FALSE', params: [] };
  }
  // Scope: row's wa_number is in the user's list,
  //   OR the contact has an explicit assigned_user_id matching this user
  //      (handled via subquery against the contacts table).
  const waParam = `$${startParamIndex}`;
  const userParam = `$${startParamIndex + 1}`;
  const sql = `(
    ${tableAlias}.wa_number = ANY(${waParam}::text[])
    OR EXISTS (
      SELECT 1 FROM coexistence.contacts c
       WHERE c.wa_number = ${tableAlias}.wa_number
         AND c.contact_number = ${tableAlias}.contact_number
         AND c.assigned_user_id = ${userParam}
    )
  )`;
  return { sql, params: [waNumbers, req.user.id] };
}

// ── SaaS tenant scoping (Phase 2) ───────────────────────────────────────────
// Build a SQL fragment that constrains a query to the request's tenant.
// Returns { sql, params } where sql is e.g. "c.tenant_id = $3" — empty (no-op)
// when there's no resolved tenant (super admin / unresolved), so it can never
// over-restrict the existing single-tenant app. `alias` is the table alias whose
// .tenant_id column to match (tenant_id was added to business tables in 064).
//
//   const ts = tenantScope(req, 'd', params.length + 1);
//   if (ts.sql) { where.push(ts.sql); params.push(...ts.params); }
function tenantScope(req, alias, startParamIndex) {
  if (req?.tenantId == null) return { sql: '', params: [] };
  const col = alias ? `${alias}.tenant_id` : 'tenant_id';
  return { sql: `${col} = $${startParamIndex}`, params: [req.tenantId] };
}

// Ergonomic variant: pushes the tenant param onto `params` and returns a clause
// fragment ("" when there's no tenant). `leading` defaults to " AND " for use in
// an existing WHERE; pass { leading: 'WHERE ' } for a fresh WHERE.
//   const where = scopeClause(req, 'd', params, { leading: 'WHERE ' });
//   const more  = scopeClause(req, 'd', params);   // " AND d.tenant_id = $N"
function scopeClause(req, alias, params, { leading = ' AND ' } = {}) {
  if (req?.tenantId == null) return '';
  params.push(req.tenantId);
  const col = alias ? `${alias}.tenant_id` : 'tenant_id';
  return `${leading}${col} = $${params.length}`;
}

// Org filter (SaaS Phase 5). Returns "<leading><alias>.organization_id = $N"
// ONLY when the request explicitly selected an organization (the org switcher set
// X-Organization-Id). Without an explicit selection ("All organizations") it's a
// no-op, so tenant-wide data is shown. Apply to org-scoped table reads alongside
// scopeClause. The table must have an organization_id column.
function orgScope(req, alias, params, { leading = ' AND ' } = {}) {
  if (!req?.orgExplicit || req.organizationId == null) return '';
  params.push(req.organizationId);
  const col = alias ? `${alias}.organization_id` : 'organization_id';
  return `${leading}${col} = $${params.length}`;
}

// Convenience: assert the current user has access to a specific wa_number.
// Admin always passes. Non-admin: must have at least one assigned contact on
// this wa_number (assigned_user_id = req.user.id). This is the *number-level*
// visibility check — to also gate a specific conversation, use
// `assertContactAccess(waNumber, contactNumber)` below.
// Does `waNumber` belong to the request's tenant? (admins bypass the per-user
// gate but remain tenant-scoped). True when there's no tenant context. Matches
// the wa_number against the tenant's whatsapp_accounts by digits-only number.
async function waInTenant(req, waNumber) {
  if (req?.tenantId == null) return true;
  const clean = String(waNumber || '').replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT 1 FROM coexistence.whatsapp_accounts
      WHERE regexp_replace(display_phone_number, '[^0-9]', '', 'g') = $1
        AND tenant_id = $2 LIMIT 1`,
    [clean, req.tenantId]
  );
  return rows.length > 0;
}

async function assertWaAccess(req, res, waNumber) {
  if (isAdmin(req.user)) {
    if (await waInTenant(req, waNumber)) return true;
    res.status(403).json({ error: 'You do not have access to this WhatsApp number' });
    return false;
  }
  const clean = String(waNumber || '').replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT 1 FROM coexistence.contacts
      WHERE wa_number = $1 AND assigned_user_id = $2 LIMIT 1`,
    [clean, req.user.id]
  );
  if (rows.length === 0) {
    res.status(403).json({ error: 'You do not have access to this WhatsApp number' });
    return false;
  }
  return true;
}

// Per-conversation access: the (wa_number, contact_number) pair must be a
// contact whose assigned_user_id matches the current user. Admin bypasses.
async function assertContactAccess(req, res, waNumber, contactNumber) {
  if (isAdmin(req.user)) {
    if (await waInTenant(req, waNumber)) return true;
    res.status(403).json({ error: 'You do not have access to this conversation' });
    return false;
  }
  const cleanWa = String(waNumber || '').replace(/\D/g, '');
  const cleanContact = String(contactNumber || '').replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT 1 FROM coexistence.contacts
      WHERE wa_number = $1 AND contact_number = $2 AND assigned_user_id = $3 LIMIT 1`,
    [cleanWa, cleanContact, req.user.id]
  );
  if (rows.length === 0) {
    res.status(403).json({ error: 'You do not have access to this conversation' });
    return false;
  }
  return true;
}

// Append-only audit log of admin-sensitive actions. tenantId/organizationId/ip
// are optional SaaS context (columns added in migration 063). When `actor` is a
// request's req.user that carried tenant context, callers can pass req to have
// them filled automatically via `from`.
async function auditLog({
  actor, action, targetType = null, targetId = null, payload = null,
  tenantId = null, organizationId = null, ip = null, from = null,
}) {
  // Convenience: derive tenant/org/ip from a request object if provided.
  if (from) {
    if (tenantId == null) tenantId = from.tenantId ?? null;
    if (organizationId == null) organizationId = from.organizationId ?? null;
    if (ip == null) ip = (from.headers?.['x-forwarded-for']?.split(',')[0] || from.ip || '').trim() || null;
  }
  try {
    await pool.query(
      `INSERT INTO coexistence.user_audit_log
         (actor_user_id, actor_username, action, target_type, target_id, payload,
          tenant_id, organization_id, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        actor?.id || null,
        actor?.username || null,
        action,
        targetType,
        targetId != null ? String(targetId) : null,
        payload ? JSON.stringify(payload) : null,
        tenantId,
        organizationId,
        ip,
      ]
    );
  } catch (err) {
    // Audit logging must never break the calling request
    console.error('[audit] write failed:', err.message);
  }
}

// Deny sensitive actions while a super admin is impersonating a tenant user
// (PRD §13 blocked actions: password change, billing, workspace deletion,
// subscription cancel, contact export). The impersonation JWT carries an `imp`
// claim, surfaced on req.user by authMiddleware.
function blockDuringImpersonation(req, res, next) {
  if (req.user?.imp) {
    return res.status(403).json({ error: 'This action is blocked while impersonating a user.' });
  }
  next();
}

module.exports = {
  adminOnly,
  blockDuringImpersonation,
  requirePermission,
  userWaNumbers,
  buildWaScope,
  tenantScope,
  scopeClause,
  orgScope,
  assertWaAccess,
  assertContactAccess,
  auditLog,
};
