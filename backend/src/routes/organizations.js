// Organizations API — SaaS Phase 5.
//
// Tenant-scoped CRUD for organizations (business units inside a tenant). Reads
// require `organizations.view`; writes require `organizations.manage`. All
// operations are pinned to the request's tenant (req.tenantId, resolved by
// tenantContext); a super admin may target a tenant via X-Tenant-Id. Org
// creation enforces the plan's `max_organizations` limit.

const { Router } = require('express');
const pool = require('../db');
const { requirePerm } = require('../rbac');
const { auditLog } = require('../middleware/access');
const { checkLimit } = require('../services/entitlements');

const router = Router();

function slugify(s) {
  return String(s || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Guard: every route needs a resolved tenant. (Super admins acting platform-wide
// must select a tenant via X-Tenant-Id; plain platform context has none.)
function requireTenant(req, res, next) {
  if (!req.tenantId) {
    return res.status(400).json({ error: 'No tenant context. Select a tenant first.' });
  }
  next();
}

// ─── List ─────────────────────────────────────────────────────────────────────
router.get('/organizations', requireTenant, requirePerm('organizations.view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.name, o.slug, o.status, o.created_at,
              (SELECT COUNT(DISTINCT ur.user_id)::int
                 FROM coexistence.user_roles ur
                WHERE ur.organization_id = o.id) AS members
         FROM coexistence.organizations o
        WHERE o.tenant_id = $1 AND o.deleted_at IS NULL
        ORDER BY o.id`,
      [req.tenantId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[orgs] list error:', err.message);
    res.status(500).json({ error: 'Failed to list organizations' });
  }
});

// ─── Detail ───────────────────────────────────────────────────────────────────
router.get('/organizations/:id', requireTenant, requirePerm('organizations.view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, slug, status, settings, created_at, updated_at
         FROM coexistence.organizations
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.tenantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[orgs] get error:', err.message);
    res.status(500).json({ error: 'Failed to load organization' });
  }
});

// ─── Create ───────────────────────────────────────────────────────────────────
router.post('/organizations', requireTenant, requirePerm('organizations.manage'), async (req, res) => {
  const { name, slug } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  const client = await pool.connect();
  try {
    // Enforce the plan's organization limit (fail-open on lookup error).
    try {
      const lim = await checkLimit(req.tenantId, 'max_organizations');
      if (!lim.allowed) {
        return res.status(403).json({
          error: `You've reached your plan's organization limit (${lim.max}). Upgrade to add more.`,
        });
      }
    } catch (e) {
      console.error('[orgs] org-limit check failed (allowing):', e.message);
    }

    const baseSlug = slugify(slug || name) || 'org';
    let finalSlug = baseSlug;
    for (let i = 0; ; i++) {
      const exists = await client.query(
        'SELECT 1 FROM coexistence.organizations WHERE tenant_id = $1 AND slug = $2',
        [req.tenantId, finalSlug]
      );
      if (exists.rows.length === 0) break;
      finalSlug = `${baseSlug}-${i + 1}`;
    }

    const { rows } = await client.query(
      `INSERT INTO coexistence.organizations (tenant_id, name, slug, status, created_by)
       VALUES ($1, $2, $3, 'active', $4) RETURNING id, name, slug, status, created_at`,
      [req.tenantId, name.trim(), finalSlug, req.user.id]
    );
    await auditLog({
      actor: req.user, action: 'organization.create',
      targetType: 'organization', targetId: rows[0].id,
      payload: { name: rows[0].name, slug: rows[0].slug },
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[orgs] create error:', err.message);
    res.status(500).json({ error: 'Failed to create organization' });
  } finally {
    client.release();
  }
});

// ─── Update (name / status) ────────────────────────────────────────────────────
router.patch('/organizations/:id', requireTenant, requirePerm('organizations.manage'), async (req, res) => {
  const { name, status } = req.body || {};
  if (status && !['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const fields = [];
    const params = [];
    let i = 1;
    if (name != null)   { fields.push(`name = $${i++}`);   params.push(String(name).trim()); }
    if (status != null) { fields.push(`status = $${i++}`); params.push(status); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    fields.push('updated_at = NOW()');
    params.push(req.params.id, req.tenantId);
    const { rows } = await pool.query(
      `UPDATE coexistence.organizations SET ${fields.join(', ')}
        WHERE id = $${i++} AND tenant_id = $${i} AND deleted_at IS NULL
        RETURNING id, name, slug, status, updated_at`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' });
    await auditLog({
      actor: req.user, action: 'organization.update',
      targetType: 'organization', targetId: req.params.id, payload: { name, status },
    });
    res.json(rows[0]);
  } catch (err) {
    console.error('[orgs] update error:', err.message);
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

// ─── Soft-delete ───────────────────────────────────────────────────────────────
router.delete('/organizations/:id', requireTenant, requirePerm('organizations.manage'), async (req, res) => {
  try {
    // Don't allow deleting the tenant's last remaining organization.
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM coexistence.organizations
        WHERE tenant_id = $1 AND deleted_at IS NULL`,
      [req.tenantId]
    );
    if ((cnt[0]?.n ?? 0) <= 1) {
      return res.status(400).json({ error: 'A tenant must keep at least one organization.' });
    }
    const { rows } = await pool.query(
      `UPDATE coexistence.organizations SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id`,
      [req.params.id, req.tenantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Organization not found' });
    await auditLog({
      actor: req.user, action: 'organization.delete',
      targetType: 'organization', targetId: req.params.id,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[orgs] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete organization' });
  }
});

module.exports = router;
