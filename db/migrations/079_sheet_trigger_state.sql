-- Polling state for the "Google Sheet row added/updated" automation trigger.
--
-- Sheets has NO row-change webhook. Drive's watch API only says "this file
-- changed" with no row detail, so the only way to know what changed is to read
-- the tab and diff it against what we saw last time. This table is that
-- "last time".
--
-- One row per (automation, tab). Keyed on the automation because two flows may
-- legitimately watch the same tab and must fire independently — sharing a
-- snapshot would mean whichever polled first silently ate the other's events.

SET search_path TO coexistence, public;

CREATE TABLE IF NOT EXISTS coexistence.sheet_trigger_state (
  id               BIGSERIAL PRIMARY KEY,
  chatbot_id       BIGINT NOT NULL REFERENCES coexistence.chatbots(id) ON DELETE CASCADE,
  google_account_id BIGINT NOT NULL REFERENCES coexistence.oauth_credentials(id) ON DELETE CASCADE,
  spreadsheet_id   TEXT NOT NULL,
  sheet_name       TEXT NOT NULL,

  -- Identity -> hash of that row's cells, as { "<identity>": "<sha1>" }.
  --
  -- Identity is derived from a USER-CHOSEN key column, never the row number:
  -- re-sorting a sheet renumbers every row, which against row numbers would
  -- look like "every row changed" and re-fire the whole tab.
  --
  -- Two rows CAN share a key value (a sheet is not a database). They still get
  -- distinct identities ("<key>#2", "<key>#3"…) — collapsing them would drop one
  -- from the snapshot, so the next poll would see it as new and fire it again
  -- EVERY TICK, forever.
  row_hashes       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Set on the first successful poll. Until then the trigger fires NOTHING:
  -- activating a flow against a 500-row sheet must not blast 500 executions.
  baselined_at     TIMESTAMPTZ,

  -- Cheap change probe: Drive's file modifiedTime. Unchanged => skip the values
  -- read entirely, so an idle trigger costs one tiny Drive call per tick.
  last_modified_time TEXT,

  last_polled_at   TIMESTAMPTZ,
  last_error       TEXT,
  consecutive_errors INT NOT NULL DEFAULT 0,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (chatbot_id, spreadsheet_id, sheet_name)
);

CREATE INDEX IF NOT EXISTS idx_sheet_trigger_state_poll
  ON coexistence.sheet_trigger_state (last_polled_at NULLS FIRST);

COMMENT ON COLUMN coexistence.sheet_trigger_state.row_hashes IS
  'identity -> sha1(row). Identity comes from a user-chosen key column; duplicates get #2, #3 suffixes so neither collapses and re-fires forever.';
