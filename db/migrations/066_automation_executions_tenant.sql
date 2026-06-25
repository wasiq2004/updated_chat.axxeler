-- 066: tenant_id on automation_executions (SaaS Phase 2 residual).
--
-- automation_executions is the run log of chatbots/automations. It carries no
-- tenant_id, so the admin dashboard's run-count aggregate and the executions
-- views couldn't be tenant-scoped. Add tenant_id (nullable, like the other
-- business tables) and backfill it from the owning chatbot.

ALTER TABLE coexistence.automation_executions
  ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES coexistence.tenants(id) ON DELETE CASCADE;

UPDATE coexistence.automation_executions e
   SET tenant_id = c.tenant_id
  FROM coexistence.chatbots c
 WHERE c.id = e.automation_id AND e.tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_automation_executions_tenant
  ON coexistence.automation_executions(tenant_id);
