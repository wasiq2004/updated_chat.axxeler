// Admin-only user management.
//
//   GET    /users                 — list all users
//   POST   /users                 — create user (returns plaintext password if generated)
//   GET    /users/:id             — single user with WA assignments
//   PATCH  /users/:id             — update displayName / email / role / permissions / is_active / wa_numbers
//   DELETE /users/:id             — remove user (and CASCADE wa assignments)
//   POST   /users/:id/reset-password — set or generate new password, returns plaintext once

const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { adminOnly, auditLog, blockDuringImpersonation } = require('../middleware/access');
const { PAGES, ROLE_PAGE_DEFAULTS } = require('../permissions');
const { checkLimit } = require('../services/entitlements');

const router = Router();

const VALID_ROLES = Object.keys(ROLE_PAGE_DEFAULTS);

// Map a legacy role to its equivalent SaaS system role, so new users are also
// represented in the new RBAC model (user_roles). Admins are tenant-wide; the
// others are scoped to the request's active organization.
const LEGACY_TO_SYSTEM_ROLE = {
  admin: 'tenant_admin',
  bda_sales: 'sales_user',
  viewer: 'support_user',
};

function shapeUser(row, waAssignments = []) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    permissions: row.permissions || null,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    assignedWaNumbers: waAssignments,
  };
}

async function loadAssignments(userIds) {
  if (userIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT user_id, wa_number FROM coexistence.user_wa_assignments WHERE user_id = ANY($1::bigint[])`,
    [userIds]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push(r.wa_number);
  }
  return map;
}

function generatePassword(len = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  // crypto.randomInt() is a CSPRNG with unbiased modulo — unlike Math.random(),
  // which is not cryptographically secure and could make generated/reset
  // passwords predictable. Same alphabet/length, so behaviour is unchanged.
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

// Client-safe validation error: its message MAY be returned to the caller.
// Unmarked errors are treated as internal and reported with a static message.
function badRequest(msg) { const e = new Error(msg); e.expose = true; return e; }

function validateRole(role) {
  if (!VALID_ROLES.includes(role)) {
    throw badRequest(`Role must be one of: ${VALID_ROLES.join(', ')}`);
  }
}

function validatePermissions(perms) {
  if (perms == null) return null;
  if (typeof perms !== 'object' || Array.isArray(perms)) {
    throw badRequest('permissions must be an object with optional grant[] and revoke[] arrays');
  }
  const out = {};
  for (const k of ['grant', 'revoke']) {
    if (perms[k] == null) continue;
    if (!Array.isArray(perms[k])) throw badRequest(`permissions.${k} must be an array`);
    const cleaned = perms[k].map(p => String(p)).filter(p => PAGES.includes(p));
    if (cleaned.length) out[k] = cleaned;
  }
  return Object.keys(out).length ? out : null;
}

// ─── List ───────────────────────────────────────────────────────────
router.get('/users', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.z_chat_users ORDER BY created_at`
    );
    const assignmentsMap = await loadAssignments(rows.map(r => r.id));
    res.json(rows.map(r => shapeUser(r, assignmentsMap.get(r.id) || [])));
  } catch (err) {
    console.error('[users] list error:', err.message);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

router.get('/users/:id', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.z_chat_users WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const assignmentsMap = await loadAssignments([rows[0].id]);
    res.json(shapeUser(rows[0], assignmentsMap.get(rows[0].id) || []));
  } catch (err) {
    console.error('[users] get error:', err.message);
    res.status(500).json({ error: 'Failed to load user' });
  }
});

// ─── Create ────────────────────────────────────────────────────────
router.post('/users', adminOnly, async (req, res) => {
  const { username, email, displayName, password, role = 'bda_sales', permissions = null, assignedWaNumbers = [] } = req.body || {};
  try {
    if (!username?.trim() || !email?.trim() || !displayName?.trim()) {
      return res.status(400).json({ error: 'username, email and displayName are required' });
    }
    validateRole(role);
    const cleanPerms = validatePermissions(permissions);

    // Enforce the tenant's plan user-limit. Fail-open on lookup errors so an
    // entitlement hiccup never blocks user management during the SaaS rollout.
    if (req.tenantId) {
      try {
        const lim = await checkLimit(req.tenantId, 'max_users');
        if (!lim.allowed) {
          return res.status(403).json({
            error: `You've reached your plan's user limit (${lim.max}). Upgrade your plan to add more users.`,
          });
        }
      } catch (e) {
        console.error('[users] user-limit check failed (allowing create):', e.message);
      }
    }

    const finalPassword = password?.trim() || generatePassword();
    const hash = await bcrypt.hash(finalPassword, 10);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO coexistence.z_chat_users
           (username, email, password, display_name, role, permissions, created_by, tenant_id)
         VALUES ($1, LOWER($2), $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING *`,
        [
          username.trim(),
          email.trim(),
          hash,
          displayName.trim(),
          role,
          cleanPerms ? JSON.stringify(cleanPerms) : null,
          req.user.id,
          req.tenantId ?? null,
        ]
      );
      const user = rows[0];

      // Dual-write the new RBAC model so this user is consistent for Phase 2
      // enforcement. tenant_admin is tenant-wide (org NULL); others are scoped
      // to the request's active organization.
      const systemRoleKey = LEGACY_TO_SYSTEM_ROLE[role];
      if (systemRoleKey && user.tenant_id != null) {
        const orgScope = systemRoleKey === 'tenant_admin' ? null : (req.organizationId ?? null);
        await client.query(
          `INSERT INTO coexistence.user_roles (user_id, role_id, organization_id, created_by)
             SELECT $1, r.id, $2, $3
               FROM coexistence.roles r
              WHERE r.key = $4 AND r.tenant_id IS NULL
           ON CONFLICT DO NOTHING`,
          [user.id, orgScope, req.user.id, systemRoleKey]
        );
      }

      // Set WA assignments (only meaningful for bda_sales; admin override is
      // technically allowed and just gets ignored at query time)
      const waList = Array.isArray(assignedWaNumbers) ? assignedWaNumbers : [];
      for (const wa of waList) {
        const clean = String(wa).replace(/\D/g, '');
        if (!clean) continue;
        await client.query(
          `INSERT INTO coexistence.user_wa_assignments (user_id, wa_number, created_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, wa_number) DO NOTHING`,
          [user.id, clean, req.user.id]
        );
      }

      await client.query('COMMIT');
      await auditLog({
        actor: req.user, action: 'user.create',
        targetType: 'user', targetId: user.id,
        payload: { username: user.username, role: user.role, waNumbers: waList },
      });

      // Return shape includes the one-time plaintext password so the UI can show it
      const assignments = await loadAssignments([user.id]);
      const shape = shapeUser(user, assignments.get(user.id) || []);
      res.status(201).json({ ...shape, generatedPassword: password ? null : finalPassword, password: finalPassword });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[users] create error:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'Email or username already in use' });
    // Only surface explicit validation messages; hide unexpected internal errors.
    if (err.expose) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ─── Update ────────────────────────────────────────────────────────
router.patch('/users/:id', adminOnly, async (req, res) => {
  const id = req.params.id;
  try {
    const { rows: existing } = await pool.query(`SELECT * FROM coexistence.z_chat_users WHERE id = $1`, [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    const before = existing[0];

    // Prevent admins from demoting / deactivating themselves to lock everyone out
    if (String(req.user.id) === String(id)) {
      if (req.body.role && req.body.role !== before.role) {
        return res.status(400).json({ error: 'You cannot change your own role' });
      }
      if (req.body.isActive === false) {
        return res.status(400).json({ error: 'You cannot deactivate yourself' });
      }
    }

    const fields = [];
    const params = [];
    let idx = 1;
    const set = (sqlFragment, val) => {
      fields.push(sqlFragment.replace('$$', `$${idx++}`));
      params.push(val);
    };

    if (req.body.displayName != null) set('display_name = $$', String(req.body.displayName).trim());
    if (req.body.email != null) set('email = $$', String(req.body.email).trim().toLowerCase());
    if (req.body.role != null) {
      validateRole(req.body.role);
      set('role = $$', req.body.role);
    }
    if (req.body.permissions !== undefined) {
      const cleanPerms = validatePermissions(req.body.permissions);
      set('permissions = $$::jsonb', cleanPerms ? JSON.stringify(cleanPerms) : null);
    }
    if (req.body.isActive != null) set('is_active = $$', !!req.body.isActive);
    fields.push(`updated_at = NOW()`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let updated = before;
      if (params.length > 0) {
        params.push(id);
        const sql = `UPDATE coexistence.z_chat_users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;
        const result = await client.query(sql, params);
        updated = result.rows[0];
      }

      // Replace wa assignments if provided
      if (Array.isArray(req.body.assignedWaNumbers)) {
        await client.query(`DELETE FROM coexistence.user_wa_assignments WHERE user_id = $1`, [id]);
        for (const wa of req.body.assignedWaNumbers) {
          const clean = String(wa).replace(/\D/g, '');
          if (!clean) continue;
          await client.query(
            `INSERT INTO coexistence.user_wa_assignments (user_id, wa_number, created_by)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, wa_number) DO NOTHING`,
            [id, clean, req.user.id]
          );
        }
      }

      await client.query('COMMIT');

      // Build a diff for the audit log
      const changes = {};
      ['display_name', 'email', 'role', 'is_active', 'permissions'].forEach(k => {
        if (JSON.stringify(before[k]) !== JSON.stringify(updated[k])) {
          changes[k] = { from: before[k], to: updated[k] };
        }
      });
      if (Array.isArray(req.body.assignedWaNumbers)) changes.assignedWaNumbers = req.body.assignedWaNumbers;
      await auditLog({
        actor: req.user,
        action: changes.role ? 'user.role_change' : 'user.update',
        targetType: 'user', targetId: id, payload: changes,
      });

      const assignmentsMap = await loadAssignments([id]);
      res.json(shapeUser(updated, assignmentsMap.get(Number(id)) || []));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[users] update error:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'Email or username already in use' });
    if (err.expose) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ─── Reset password (admin-only, plaintext-once display) ──────────
router.post('/users/:id/reset-password', adminOnly, blockDuringImpersonation, async (req, res) => {
  const id = req.params.id;
  try {
    const { rows: existing } = await pool.query(
      `SELECT id, username FROM coexistence.z_chat_users WHERE id = $1`,
      [id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });

    const password = req.body?.password?.trim() || generatePassword();
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE coexistence.z_chat_users SET password = $1, updated_at = NOW() WHERE id = $2`,
      [hash, id]
    );
    await auditLog({
      actor: req.user, action: 'user.password_reset',
      targetType: 'user', targetId: id, payload: { byAdmin: req.user.username },
    });
    res.json({ password, generated: !req.body?.password });
  } catch (err) {
    console.error('[users] reset-password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ─── Delete ───────────────────────────────────────────────────────
router.delete('/users/:id', adminOnly, blockDuringImpersonation, async (req, res) => {
  const id = req.params.id;
  try {
    if (String(req.user.id) === String(id)) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }
    const { rows: existing } = await pool.query(
      `SELECT username, role FROM coexistence.z_chat_users WHERE id = $1`,
      [id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
    await pool.query(`DELETE FROM coexistence.z_chat_users WHERE id = $1`, [id]);
    await auditLog({
      actor: req.user, action: 'user.delete',
      targetType: 'user', targetId: id, payload: existing[0],
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[users] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ─── Audit log (paginated) ────────────────────────────────────────
router.get('/audit-log', adminOnly, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 50, 10), 200);
    const offset = Math.max(parseInt(req.query.offset || 0, 10), 0);
    const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total FROM coexistence.user_audit_log`);
    const { rows } = await pool.query(
      `SELECT id, actor_user_id AS "actorUserId", actor_username AS "actorUsername",
              action, target_type AS "targetType", target_id AS "targetId",
              payload, created_at AS "createdAt"
         FROM coexistence.user_audit_log
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ total: countRows[0].total, limit, offset, items: rows });
  } catch (err) {
    console.error('[users] audit-log error:', err.message);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

module.exports = { router };
