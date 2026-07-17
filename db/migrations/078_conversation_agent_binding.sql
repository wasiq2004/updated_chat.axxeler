-- Per-conversation AI agent binding, for the "Handoff to AI Agent" flow node.
--
-- Until now "which agent handles this contact" was resolved fresh on every
-- inbound from (wa_number -> account -> the ONE active agent). That is fine for
-- a default, but it makes "hand THIS conversation to agent B" impossible: only
-- one agent per account may be active (partial unique index
-- idx_agents_one_active_per_account), so the agent a flow wants to hand off to
-- is usually not the account's active one.
--
-- Binding lives on the contact, so it survives across inbounds and is visible in
-- the same place as the pause/handoff state it interacts with.
--
-- ON DELETE SET NULL, not CASCADE: deleting an agent must not delete the
-- customer. The conversation simply reverts to the account's default agent.

SET search_path TO coexistence, public;

ALTER TABLE coexistence.contacts
  ADD COLUMN IF NOT EXISTS agent_id BIGINT REFERENCES coexistence.agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agent_bound_at TIMESTAMPTZ,
  -- What the FLOW concluded before handing over — the transcript can't show it
  -- ("qualified as enterprise", "wants the 20-seat plan"). Injected into the
  -- agent's system prompt so it doesn't re-ask for what the flow already knows.
  ADD COLUMN IF NOT EXISTS agent_brief TEXT;

COMMENT ON COLUMN coexistence.contacts.agent_id IS
  'Explicitly bound agent for this conversation (set by the Handoff to AI Agent node). Takes precedence over the WA account''s active agent. NULL = use the account default.';

-- Finding bound conversations for an agent (e.g. before deactivating it).
CREATE INDEX IF NOT EXISTS idx_contacts_agent_id
  ON coexistence.contacts (agent_id) WHERE agent_id IS NOT NULL;
