-- Saved sheet library: connect a spreadsheet + tab once, name it, then pick it
-- BY NAME anywhere a sheet is needed.
--
-- Workspace-shared, not per-user: a flow built by one person must keep working
-- when someone else edits it, and "my sheets" would make a shared automation
-- depend on whose account happened to create it.
--
-- The picker COPIES the resolved ids onto the node rather than storing a
-- reference. So deleting a library entry cannot break a flow already using it —
-- the entry just disappears from the picker. The trade-off, accepted and stated
-- in the UI: re-pointing an entry does NOT retro-update existing flows.
--
-- Bonus, and the real reason this earns its place: a saved sheet already knows
-- its spreadsheet id, so USING one needs only the `spreadsheets` scope. It
-- sidesteps the Drive browse-scope problem entirely — an account connected
-- without `drive.readonly` can't list spreadsheets, but it can read a known one.

SET search_path TO coexistence, public;

CREATE TABLE IF NOT EXISTS coexistence.saved_sheets (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL,                    -- the friendly name people pick
  google_account_id BIGINT NOT NULL REFERENCES coexistence.oauth_credentials(id) ON DELETE CASCADE,
  spreadsheet_id    TEXT NOT NULL,
  spreadsheet_name  TEXT,                             -- cached for display; the id is the truth
  sheet_name        TEXT NOT NULL,                    -- the tab

  tenant_id         BIGINT REFERENCES coexistence.tenants(id) ON DELETE CASCADE,
  organization_id   BIGINT REFERENCES coexistence.organizations(id) ON DELETE CASCADE,
  created_by        BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One entry per name per workspace, so "Enquiries" is unambiguous in a picker.
-- NULLS NOT DISTINCT so the platform-level (tenant_id IS NULL) rows collide too.
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_sheets_tenant_name
  ON coexistence.saved_sheets (tenant_id, lower(name)) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_saved_sheets_tenant
  ON coexistence.saved_sheets (tenant_id);

COMMENT ON TABLE coexistence.saved_sheets IS
  'Named spreadsheet+tab shortcuts. Pickers COPY the ids onto the node, so deleting an entry never breaks a live flow.';
