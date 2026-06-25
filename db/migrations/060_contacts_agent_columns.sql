-- 060: Add the per-conversation agent columns the code already reads/writes on
-- coexistence.contacts. These were referenced by the handoff + close-summary
-- features (agentHandoff.js, agentCloseSummary.js, agentEngine.js) but never
-- had a migration, so a fresh DB errors with
--   "column c.agent_close_pending does not exist".
--
-- agent_paused*       : a human took over the conversation, so the agent stops
--                       auto-replying (set/cleared by agentHandoff.js).
-- agent_close_pending : an idle-summary run happened and a close summary is owed
--                       once the conversation goes quiet (close-summary sweep).
-- agent_last_run_at   : timestamp of the last agent run, drives the idle window.
ALTER TABLE coexistence.contacts
  ADD COLUMN IF NOT EXISTS agent_paused         BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS agent_paused_by      TEXT,
  ADD COLUMN IF NOT EXISTS agent_paused_reason  TEXT,
  ADD COLUMN IF NOT EXISTS agent_paused_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_close_pending  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS agent_last_run_at    TIMESTAMPTZ;
