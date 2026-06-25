-- 065: Per-tenant default WhatsApp account (SaaS multi-tenancy).
--
-- The original 013 migration put a GLOBAL single-default constraint on
-- whatsapp_accounts (only one row platform-wide could be is_default=TRUE). In a
-- multi-tenant world each tenant needs its own default account. Replace the
-- global unique index with a per-tenant one. NULL tenant_id (platform-owned)
-- rows are treated as distinct by the unique index, which is fine.

DROP INDEX IF EXISTS coexistence.idx_whatsapp_accounts_one_default;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_accounts_one_default_per_tenant
  ON coexistence.whatsapp_accounts (tenant_id)
  WHERE is_default = TRUE;
