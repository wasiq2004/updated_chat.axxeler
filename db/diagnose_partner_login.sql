-- Diagnose "partner can't log in". Read-only — safe to run on production.
--
--   docker compose exec -T postgres psql -U postgres -d <db> -f /path/to/this.sql
--   (or paste it into any psql session)
--
-- Read the output like this:
--   admin_email        — this is the ONLY thing that works at the login form.
--                        The username does NOT work: login matches on email.
--   email_released     — t  => this partner was deleted; its address was freed
--                             and this row can no longer log in (expected).
--   login_enabled      — f  => "Account is disabled" (not "Invalid credentials").
--   has_password       — f  => no hash stored; every attempt is invalid.
--   reseller_deleted   — t  => partner is deleted; it won't appear in the console.
--   admin_rows         — >1 => more than one candidate admin; the console shows
--                              the LOWEST id, so a reset may target another row.
--   0 rows for a partner => it has no admin user at all (nothing to log in as).

SELECT
  r.id                                   AS reseller_id,
  r.name                                 AS partner,
  r.slug                                 AS login_slug,
  r.status                               AS partner_status,
  (r.deleted_at IS NOT NULL)             AS reseller_deleted,
  u.id                                   AS admin_user_id,
  u.email                                AS admin_email,
  u.username                             AS admin_username,
  u.is_active                            AS login_enabled,
  (u.email LIKE '%+deleted%')            AS email_released,
  (u.password IS NOT NULL AND u.password <> '') AS has_password,
  left(coalesce(u.password, ''), 4)      AS hash_prefix,   -- expect $2a/$2b (bcrypt)
  u.tenant_id                            AS admin_tenant_id, -- MUST be NULL
  u.last_login_at,
  (SELECT COUNT(*) FROM coexistence.z_chat_users x
     WHERE x.reseller_id = r.id AND x.tenant_id IS NULL)    AS admin_rows,
  (SELECT COUNT(*) FROM coexistence.user_roles ur
     JOIN coexistence.roles ro ON ro.id = ur.role_id
    WHERE ur.user_id = u.id AND ro.key = 'reseller_admin')  AS has_reseller_role
FROM coexistence.resellers r
LEFT JOIN LATERAL (
  SELECT * FROM coexistence.z_chat_users u2
   WHERE u2.reseller_id = r.id AND u2.tenant_id IS NULL
   ORDER BY u2.id ASC LIMIT 1
) u ON TRUE
ORDER BY r.created_at DESC;

-- Any user still squatting an email for a DELETED partner (migration 073 clears
-- these; if rows appear here, 073 has not run yet):
SELECT u.id, u.email, u.is_active, r.name AS deleted_partner
  FROM coexistence.z_chat_users u
  JOIN coexistence.resellers r ON r.id = u.reseller_id
 WHERE u.tenant_id IS NULL
   AND r.deleted_at IS NOT NULL
   AND u.email NOT LIKE '%+deleted%';
