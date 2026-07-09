-- Follow-up sequences: a named series of timed template messages a contact can
-- be enrolled in (via the Start Sequence automation action or the Follow-ups
-- page). A 60s sweeper sends the next step when it comes due.

SET search_path TO coexistence, public;

CREATE TABLE IF NOT EXISTS coexistence.sequences (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  -- steps: [{ templateId, delayValue, delayUnit ('minutes'|'hours'|'days') }]
  steps           JSONB NOT NULL DEFAULT '[]'::jsonb,
  tenant_id       BIGINT REFERENCES coexistence.tenants(id) ON DELETE CASCADE,
  organization_id BIGINT REFERENCES coexistence.organizations(id) ON DELETE SET NULL,
  created_by      BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sequences_tenant ON coexistence.sequences(tenant_id);

CREATE TABLE IF NOT EXISTS coexistence.sequence_enrollments (
  id             BIGSERIAL PRIMARY KEY,
  sequence_id    BIGINT NOT NULL REFERENCES coexistence.sequences(id) ON DELETE CASCADE,
  wa_number      TEXT NOT NULL,
  contact_number TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','ended')),
  next_step      INT  NOT NULL DEFAULT 0,          -- index into sequences.steps
  next_send_at   TIMESTAMPTZ,                       -- when the next step is due
  tenant_id      BIGINT REFERENCES coexistence.tenants(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One live enrollment per contact per sequence.
  UNIQUE (sequence_id, wa_number, contact_number)
);
CREATE INDEX IF NOT EXISTS idx_seq_enroll_due
  ON coexistence.sequence_enrollments(next_send_at) WHERE status = 'active';
