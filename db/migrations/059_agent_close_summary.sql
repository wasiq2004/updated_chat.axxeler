-- 059: Add close-summary columns to agents table.
-- close_summary_enabled: when TRUE the agent sends an AI-generated summary
--   message when a conversation goes idle for close_idle_minutes.
-- close_idle_minutes: idle threshold before the close-summary sweep fires.
ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS close_summary_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS close_idle_minutes    INT     NOT NULL DEFAULT 30;
