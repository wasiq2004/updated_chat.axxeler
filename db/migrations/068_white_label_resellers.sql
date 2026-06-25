-- White-label resellers (partners). A reseller is a new tier ABOVE admins: the
-- platform owner (us) creates resellers; each reseller gets its OWN scoped Super
-- Admin console, its OWN branded login, its OWN plan catalog & pricing, and
-- manages ONLY its own admins (tenants). We keep running the database.
--
--   Platform Super Admin  (reseller_id NULL, super_admin role)
--     └─ Reseller / partner            (resellers)
--          └─ Admin / tenant           (tenants.reseller_id)
--               └─ Organization → User
--
-- Everything is nullable + backfilled: existing tenants/plans/users keep
-- reseller_id = NULL (platform-direct) so the current install is unchanged.

SET search_path TO coexistence, public;

-- ── 1. Resellers ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.resellers (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,        -- used at login (?w=<slug>) to pre-brand
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  branding    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { brandName, primaryColor, logoUrl, loginTagline }
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL,
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_resellers_status ON coexistence.resellers(status) WHERE deleted_at IS NULL;

-- ── 2. Tie the hierarchy together (all NULL = platform-direct) ────────────────
ALTER TABLE coexistence.tenants
  ADD COLUMN IF NOT EXISTS reseller_id BIGINT REFERENCES coexistence.resellers(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_tenants_reseller ON coexistence.tenants(reseller_id);

ALTER TABLE coexistence.z_chat_users
  ADD COLUMN IF NOT EXISTS reseller_id BIGINT REFERENCES coexistence.resellers(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_users_reseller ON coexistence.z_chat_users(reseller_id);

ALTER TABLE coexistence.plans
  ADD COLUMN IF NOT EXISTS reseller_id BIGINT REFERENCES coexistence.resellers(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_plans_reseller ON coexistence.plans(reseller_id);

-- Plan keys are unique PER catalog (platform = reseller_id NULL, or per reseller),
-- not globally — a partner may have their own 'starter'. Drop the global unique,
-- add a per-reseller one (NULLS NOT DISTINCT so platform keys stay unique too).
ALTER TABLE coexistence.plans DROP CONSTRAINT IF EXISTS plans_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_reseller_key
  ON coexistence.plans (reseller_id, key) NULLS NOT DISTINCT;

-- ── 3. Reseller-admin system role ─────────────────────────────────────────────
-- A reseller admin operates the scoped console for ONE reseller (no tenant). It
-- holds every permission like super_admin, but the platform API scopes its reads
-- to its own reseller_id.
INSERT INTO coexistence.roles (tenant_id, key, name, description, is_system) VALUES
  (NULL, 'reseller_admin', 'Reseller Admin', 'White-label partner — scoped platform owner over their own admins', TRUE)
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  reseller_admin BIGINT := (SELECT id FROM coexistence.roles WHERE key = 'reseller_admin' AND tenant_id IS NULL);
  pid BIGINT;
BEGIN
  IF reseller_admin IS NOT NULL THEN
    FOR pid IN SELECT id FROM coexistence.permissions LOOP
      INSERT INTO coexistence.role_permissions (role_id, permission_id) VALUES (reseller_admin, pid)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
END $$;
