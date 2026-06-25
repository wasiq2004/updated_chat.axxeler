-- 061: Add the agent-level handoff + CRM-tools columns the code already
-- reads/writes on coexistence.agents but that never had a migration, so a
-- fresh/existing DB errors with
--   "column a.handoff_enabled does not exist"
-- on every inbound webhook (agentRouter.js) and when creating an agent
-- (agentService.js createAgent INSERT).
--
-- handoff_enabled   : keyword/manual human-handoff is turned on for the agent.
-- handoff_user_ids  : JSON array of team-member ids to assign the conversation
--                     to on handoff (stored via JSON.stringify => jsonb).
-- handoff_keywords  : free-text keyword list that triggers a handoff.
-- crm_tools_enabled : the agent may call the built-in CRM tools.
ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS handoff_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS handoff_user_ids   JSONB   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS handoff_keywords   TEXT    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS crm_tools_enabled  BOOLEAN NOT NULL DEFAULT FALSE;
