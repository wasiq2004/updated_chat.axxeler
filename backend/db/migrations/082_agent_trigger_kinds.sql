-- Per-kind agent activation + tag scoping.
--
-- BEFORE: one active agent per WhatsApp account, of ANY kind
-- (idx_agents_one_active_per_account). That made "a keyword bot for PRICE and a
-- keyword bot for SUPPORT" impossible, and enabling any second agent 409'd with
-- "Disable it first".
--
-- AFTER, per WhatsApp account:
--   trigger_mode='any'      -> at most ONE active  (two always-on bots would race)
--   trigger_mode='new'      -> at most ONE active  (a first message has exactly one taker)
--   trigger_mode='keyword'  -> UNLIMITED active    (each is scoped by its keyword)
--
-- Enforced the same way the old rule was: partial unique indexes, so paused
-- drafts of every kind can still pile up freely.
--
-- ALSO: the CHECK constraint still said ('any','keyword') while the router and
-- the editor UI both already supported 'new' — and routes/agents.js silently
-- coerced 'new' to 'any' on save. Anyone who picked "New conversations only"
-- actually shipped an agent that answers EVERYBODY. The route fix lands with
-- this migration; the CHECK is widened here.
--
-- trigger_tags: tag IDs (JSONB array of numbers). Empty = no restriction. At
-- routing time the agent only engages contacts carrying at least one of these
-- tags — matched by id OR name (contacts.tags entries can carry stale/missing
-- ids; see automationEngine's Remove Tag and scheduleTrigger's audience).

SET search_path TO coexistence, public;

-- 1. Widen the mode CHECK. Guarded drop+add: constraint names survive ALTERs.
ALTER TABLE coexistence.agents
  DROP CONSTRAINT IF EXISTS agents_trigger_mode_check;
ALTER TABLE coexistence.agents
  ADD CONSTRAINT agents_trigger_mode_check
  CHECK (trigger_mode IN ('any', 'new', 'keyword'));

-- 2. Tag scope.
ALTER TABLE coexistence.agents
  ADD COLUMN IF NOT EXISTS trigger_tags JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 3. Replace the blanket one-active rule with per-kind rules.
DROP INDEX IF EXISTS coexistence.idx_agents_one_active_per_account;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_one_active_any_per_account
  ON coexistence.agents (wa_account_id)
  WHERE is_active = TRUE AND trigger_mode = 'any';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_one_active_new_per_account
  ON coexistence.agents (wa_account_id)
  WHERE is_active = TRUE AND trigger_mode = 'new';

-- No index for 'keyword' — deliberately unlimited.

COMMENT ON COLUMN coexistence.agents.trigger_tags IS
  'Tag IDs (JSONB number array). Non-empty = the agent only engages contacts carrying at least one of these tags. Matched by id OR name at routing time.';
