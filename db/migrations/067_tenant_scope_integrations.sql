-- Tenant-scope the integration credentials so each admin (tenant) uses ONLY their
-- own Google OAuth app, Google connections, MCP settings, and MCP API keys —
-- nothing is shared across workspaces. Columns are added nullable + backfilled to
-- the bootstrap default tenant so the existing single install keeps working.

SET search_path TO coexistence, public;

-- ── 1. Google OAuth APP credentials (Client ID / Secret / Redirect) ───────────
-- One configured Google app per tenant.
ALTER TABLE coexistence.google_oauth_credentials
  ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES coexistence.tenants(id) ON DELETE CASCADE;
-- The old table had no per-tenant uniqueness and the service used "newest row
-- wins". Collapse to a single row before assigning it to the default tenant so
-- the unique index below can't fail on duplicate backfilled tenant_ids.
DELETE FROM coexistence.google_oauth_credentials
 WHERE id NOT IN (SELECT MAX(id) FROM coexistence.google_oauth_credentials);
UPDATE coexistence.google_oauth_credentials
   SET tenant_id = (SELECT id FROM coexistence.tenants ORDER BY id LIMIT 1)
 WHERE tenant_id IS NULL;
-- Keep at most one app-credential row per tenant (the service upserts on it).
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_oauth_creds_tenant
  ON coexistence.google_oauth_credentials(tenant_id);

-- ── 2. Google CONNECTIONS (oauth_credentials) ─────────────────────────────────
-- Stamp the owning user's tenant so token refresh can pick the right tenant's
-- Google app, and so MCP discovery can scope connections by tenant.
ALTER TABLE coexistence.oauth_credentials
  ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES coexistence.tenants(id) ON DELETE CASCADE;
UPDATE coexistence.oauth_credentials oc
   SET tenant_id = u.tenant_id
  FROM coexistence.z_chat_users u
 WHERE oc.user_id = u.id AND oc.tenant_id IS NULL;
-- Fallback: any connection still unstamped (e.g. owned by a tenant-less user)
-- goes to the default tenant so it stays visible to tenant-scoped MCP discovery
-- (mirrors the mcp_api_keys fallback below).
UPDATE coexistence.oauth_credentials
   SET tenant_id = (SELECT id FROM coexistence.tenants ORDER BY id LIMIT 1)
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_credentials_tenant
  ON coexistence.oauth_credentials(tenant_id);

-- ── 3. MCP API keys ───────────────────────────────────────────────────────────
ALTER TABLE coexistence.mcp_api_keys
  ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES coexistence.tenants(id) ON DELETE CASCADE;
UPDATE coexistence.mcp_api_keys k
   SET tenant_id = u.tenant_id
  FROM coexistence.z_chat_users u
 WHERE k.created_by = u.id AND k.tenant_id IS NULL;
UPDATE coexistence.mcp_api_keys
   SET tenant_id = (SELECT id FROM coexistence.tenants ORDER BY id LIMIT 1)
 WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_tenant
  ON coexistence.mcp_api_keys(tenant_id);

-- ── 4. MCP settings — singleton → one row per tenant ──────────────────────────
-- The old table was a forced single row (id INT PRIMARY KEY DEFAULT 1 CHECK id=1).
-- Drop the id=1 check, add tenant_id, give id a real sequence so new per-tenant
-- rows can be inserted, and enforce one settings row per tenant.
ALTER TABLE coexistence.mcp_settings DROP CONSTRAINT IF EXISTS mcp_settings_id_check;
ALTER TABLE coexistence.mcp_settings
  ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES coexistence.tenants(id) ON DELETE CASCADE;
UPDATE coexistence.mcp_settings
   SET tenant_id = (SELECT id FROM coexistence.tenants ORDER BY id LIMIT 1)
 WHERE tenant_id IS NULL;
CREATE SEQUENCE IF NOT EXISTS coexistence.mcp_settings_id_seq OWNED BY coexistence.mcp_settings.id;
SELECT setval('coexistence.mcp_settings_id_seq',
              GREATEST(COALESCE((SELECT MAX(id) FROM coexistence.mcp_settings), 1), 1));
ALTER TABLE coexistence.mcp_settings ALTER COLUMN id SET DEFAULT nextval('coexistence.mcp_settings_id_seq');
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_settings_tenant
  ON coexistence.mcp_settings(tenant_id);
