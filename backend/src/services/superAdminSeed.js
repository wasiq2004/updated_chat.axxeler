// Platform super-admin seeding (SaaS Phase 3 bootstrap).
//
// Runs once at boot, AFTER migrations + ensureTables. A super admin is a
// platform-level account with NO tenant (z_chat_users.tenant_id IS NULL) holding
// the system `super_admin` role. None is created by the migration (so existing
// installs aren't silently granted platform power) — it is opt-in via env:
//
//   SUPER_ADMIN_EMAIL=owner@example.com
//   SUPER_ADMIN_PASSWORD=...            (only used when the account is created)
//
// Idempotent: if the email already exists we just ensure it has the super_admin
// role and no tenant; the password is never overwritten on an existing account.

const bcrypt = require('bcryptjs');

async function seedSuperAdmin(pool) {
  const email = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) return; // feature is opt-in

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const roleRes = await client.query(
      `SELECT id FROM coexistence.roles WHERE key = 'super_admin' AND tenant_id IS NULL`
    );
    const roleId = roleRes.rows[0]?.id;
    if (!roleId) {
      // Foundation migration (063) hasn't seeded system roles yet — skip quietly.
      await client.query('ROLLBACK');
      console.warn('[super-admin] super_admin role not found — apply migration 063 first; skipping seed.');
      return;
    }

    let userRes = await client.query(
      `SELECT id FROM coexistence.z_chat_users WHERE email = $1`,
      [email]
    );
    let userId = userRes.rows[0]?.id;

    if (!userId) {
      const password = process.env.SUPER_ADMIN_PASSWORD;
      if (!password) {
        await client.query('ROLLBACK');
        console.warn(
          `[super-admin] SUPER_ADMIN_EMAIL=${email} has no account and SUPER_ADMIN_PASSWORD is unset — ` +
          'set it once to create the platform owner; skipping.'
        );
        return;
      }
      const hash = await bcrypt.hash(password, 10);
      // Username must be unique; derive from the email local-part, fall back to a suffix.
      const base = email.split('@')[0].replace(/[^a-z0-9_.-]/gi, '') || 'superadmin';
      let username = base;
      for (let i = 0; ; i++) {
        const exists = await client.query(
          'SELECT 1 FROM coexistence.z_chat_users WHERE username = $1', [username]
        );
        if (exists.rows.length === 0) break;
        username = `${base}${i + 1}`;
      }
      const ins = await client.query(
        `INSERT INTO coexistence.z_chat_users (username, email, password, display_name, role, tenant_id, is_active)
         VALUES ($1, $2, $3, 'Super Admin', 'admin', NULL, TRUE)
         RETURNING id`,
        [username, email, hash]
      );
      userId = ins.rows[0].id;
      console.log(`[super-admin] created platform super admin '${email}'.`);
    } else {
      // Ensure an existing account is platform-scoped (no tenant).
      await client.query('UPDATE coexistence.z_chat_users SET tenant_id = NULL WHERE id = $1', [userId]);
    }

    // Ensure the super_admin role is assigned (tenant-wide / no org).
    await client.query(
      `INSERT INTO coexistence.user_roles (user_id, role_id, organization_id)
       VALUES ($1, $2, NULL)
       ON CONFLICT DO NOTHING`,
      [userId, roleId]
    );

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[super-admin] seed failed:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { seedSuperAdmin };
