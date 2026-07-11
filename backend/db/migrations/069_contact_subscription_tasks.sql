-- Subscription state for contacts (powers the Subscribe/Unsubscribe Contact
-- automation actions) + a lightweight tasks table (powers the Human Handoff
-- "Create Task" notification and the /api/tasks surface).

SET search_path TO coexistence, public;

-- ── Contact subscription ──────────────────────────────────────────────────────
ALTER TABLE coexistence.contacts
  ADD COLUMN IF NOT EXISTS subscribed BOOLEAN NOT NULL DEFAULT TRUE;

-- ── Tasks ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.tasks (
  id               BIGSERIAL PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  priority         TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  due_at           TIMESTAMPTZ,
  assigned_user_id BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL,
  wa_number        TEXT,
  contact_number   TEXT,
  source           TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'automation_handoff'
  created_by       BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL,
  tenant_id        BIGINT REFERENCES coexistence.tenants(id) ON DELETE CASCADE,
  organization_id  BIGINT REFERENCES coexistence.organizations(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status ON coexistence.tasks(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON coexistence.tasks(assigned_user_id) WHERE status = 'open';
