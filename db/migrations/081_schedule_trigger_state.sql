-- Scheduled automation triggers: run a flow on a clock.
--
-- TIMING MODEL — a wall-clock DATE STRING in the trigger's own timezone.
--
-- "Has today's slot fired?" is answered by comparing `last_fired_date`
-- ('2026-07-16') to today's date IN THAT TIMEZONE. This needs no UTC/DST
-- arithmetic at all, and once the date is stored a double-fire is structurally
-- impossible rather than merely unlikely.
--
-- LEASING — a fixed lease is not enough.
--
-- A 1000-contact fan-out can run for ~30 minutes and outlive any fixed lease;
-- the next tick then re-claims and messages everyone a second time. So:
--   * lease_token   — a fencing token. The runner re-checks it and ABORTS the
--                     fan-out if it ever loses ownership.
--   * lease_expires_at — renewed by a heartbeat DURING the run, not set once.
-- The lease is released only if we still own it (token match), or a slow run
-- would clear the lease of the run that replaced it and a third would start.

SET search_path TO coexistence, public;

CREATE TABLE IF NOT EXISTS coexistence.schedule_trigger_state (
  id            BIGSERIAL PRIMARY KEY,
  chatbot_id    BIGINT NOT NULL REFERENCES coexistence.chatbots(id) ON DELETE CASCADE,

  -- 'YYYY-MM-DD' in the trigger's timezone. The whole double-fire guard.
  last_fired_date TEXT,
  -- The wall-clock slot we claimed, stamped AT CLAIM TIME — before fanning out.
  -- A crash mid-fan-out then forfeits the slot rather than replaying it.
  last_fired_at TIMESTAMPTZ,

  -- Fencing token: whoever holds it owns the run. NULL = free.
  lease_token   TEXT,
  lease_expires_at TIMESTAMPTZ,

  -- Which timezone last_fired_date was computed in. Changing the trigger's
  -- timezone makes the stored date meaningless (it's in the OLD zone and can
  -- look stale), which would re-fire the same day — see the min-gap guard.
  last_fired_tz TEXT,

  last_run_contacts INT,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (chatbot_id)
);

CREATE INDEX IF NOT EXISTS idx_schedule_trigger_lease
  ON coexistence.schedule_trigger_state (lease_expires_at) WHERE lease_token IS NOT NULL;

COMMENT ON COLUMN coexistence.schedule_trigger_state.lease_token IS
  'Fencing token. The fan-out re-checks it and aborts if lost — a fixed lease alone lets a slow run be re-claimed and message everyone twice.';
