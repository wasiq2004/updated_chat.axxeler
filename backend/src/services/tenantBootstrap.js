// Attach tenant-less users to the default tenant (SaaS Phase 1/2 boot step).
//
// Migration 063 maps users that EXIST when it runs onto the default tenant. But
// on a fresh install the first admin is created AFTER migrations (by auth.js
// ensureTables() / the setup wizard), so it would be left with tenant_id NULL
// and no RBAC role. This runs every boot (after ensureTables + seedSuperAdmin)
// and reconciles any such orphan: it attaches them to the default tenant and
// grants the equivalent system role. Idempotent — a no-op once everyone is
// attached. Super admins (tenant_id NULL by design) are skipped.

async function attachOrphanUsers(pool) {
  const client = await pool.connect();
  try {
    const t = await client.query(`SELECT id FROM coexistence.tenants WHERE slug = 'default'`);
    const tenantId = t.rows[0]?.id;
    if (!tenantId) return; // foundation migration not applied yet

    const o = await client.query(
      `SELECT id FROM coexistence.organizations WHERE tenant_id = $1 AND slug = 'default'`,
      [tenantId]
    );
    const orgId = o.rows[0]?.id ?? null;

    const roleId = async (key) =>
      (await client.query(`SELECT id FROM coexistence.roles WHERE key = $1 AND tenant_id IS NULL`, [key]))
        .rows[0]?.id ?? null;
    const tenantAdmin = await roleId('tenant_admin');
    const salesUser = await roleId('sales_user');
    const supportUser = await roleId('support_user');

    // Orphans: no tenant AND not a platform super admin.
    const { rows: orphans } = await client.query(`
      SELECT u.id, u.role
        FROM coexistence.z_chat_users u
       WHERE u.tenant_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM coexistence.user_roles ur
             JOIN coexistence.roles r ON r.id = ur.role_id
            WHERE ur.user_id = u.id AND r.key = 'super_admin'
         )
    `);
    if (orphans.length === 0) return;

    await client.query('BEGIN');
    for (const u of orphans) {
      await client.query(`UPDATE coexistence.z_chat_users SET tenant_id = $1 WHERE id = $2`, [tenantId, u.id]);
      let rid = tenantAdmin, org = null; // admin → tenant-wide
      if (u.role === 'bda_sales') { rid = salesUser; org = orgId; }
      else if (u.role === 'viewer') { rid = supportUser; org = orgId; }
      if (rid) {
        await client.query(
          `INSERT INTO coexistence.user_roles (user_id, role_id, organization_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [u.id, rid, org]
        );
      }
    }
    await client.query('COMMIT');
    console.log(`[tenant-bootstrap] attached ${orphans.length} user(s) to the default tenant.`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[tenant-bootstrap] attach failed:', err.message);
  } finally {
    client.release();
  }
}

module.exports = { attachOrphanUsers };
