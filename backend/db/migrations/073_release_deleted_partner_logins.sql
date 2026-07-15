-- Release the login of any ALREADY soft-deleted partner (reseller).
--
-- Deleting a partner soft-deletes the reseller row, but its scoped admin user
-- (reseller_id set, no tenant) was left behind still holding its email and
-- username. Effects:
--   * that address can never be reused — re-creating the partner with the same
--     email fails the duplicate check with a confusing "user already exists";
--   * a disabled account with a valid password hash lingers.
--
-- This frees the address on rows that belong to a deleted partner. The user row
-- itself is KEPT: audit entries and created_by columns reference it.
--
-- Safety: only touches users whose reseller is deleted, never a live partner or
-- any tenant user (tenant_id IS NULL is part of the match). The NOT LIKE guard
-- makes it idempotent and stops a second run from double-suffixing.

SET search_path TO coexistence, public;

UPDATE coexistence.z_chat_users u
   SET is_active  = FALSE,
       email      = u.email    || '+deleted' || u.id,
       username   = u.username || '+deleted' || u.id,
       updated_at = NOW()
  FROM coexistence.resellers r
 WHERE u.reseller_id = r.id
   AND u.tenant_id IS NULL
   AND r.deleted_at IS NOT NULL
   AND u.email NOT LIKE '%+deleted%';
