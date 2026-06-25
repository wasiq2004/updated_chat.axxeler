-- 064: Retrofit tenant_id / organization_id onto the core business tables.
--
-- Columns are added NULLABLE and backfilled to the bootstrapped default
-- tenant/organization (see 063). NOT NULL + write-path enforcement is deferred
-- to a later phase (ARCHITECTURE.md, Phase 2) so the live single-tenant app —
-- which does not yet set these columns on INSERT — keeps working.
--
-- `tenant_id` is added to every business table; `organization_id` only to tables
-- that are naturally organization-scoped (an org owns one WhatsApp account and
-- everything that hangs off it). Tables that are children of an already-scoped
-- parent (pipeline_stages → pipelines, broadcast_logs → broadcasts) still carry
-- tenant_id for fast, index-only tenant filtering.

DO $$
DECLARE
  t_id BIGINT := (SELECT id FROM coexistence.tenants WHERE slug = 'default');
  o_id BIGINT := (SELECT o.id FROM coexistence.organizations o
                    JOIN coexistence.tenants t ON t.id = o.tenant_id
                   WHERE t.slug = 'default' AND o.slug = 'default');
  tbl  TEXT;
  -- tenant_id only
  tenant_only TEXT[] := ARRAY[
    'pipeline_stages','broadcast_logs','contact_field_definitions','ai_models'
  ];
  -- tenant_id + organization_id
  tenant_org  TEXT[] := ARRAY[
    'whatsapp_accounts','contacts','chat_history','broadcasts','message_templates',
    'deals','pipelines','agents','chatbots','tags','categories','media_library',
    'conversation_reads','wa_links'
  ];
BEGIN
  -- tenant_id-only tables
  FOREACH tbl IN ARRAY tenant_only LOOP
    IF to_regclass('coexistence.' || tbl) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE coexistence.%I ADD COLUMN IF NOT EXISTS tenant_id BIGINT
           REFERENCES coexistence.tenants(id) ON DELETE CASCADE', tbl);
      EXECUTE format('UPDATE coexistence.%I SET tenant_id = $1 WHERE tenant_id IS NULL', tbl) USING t_id;
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON coexistence.%I(tenant_id)',
                     'idx_' || tbl || '_tenant', tbl);
    END IF;
  END LOOP;

  -- tenant_id + organization_id tables
  FOREACH tbl IN ARRAY tenant_org LOOP
    IF to_regclass('coexistence.' || tbl) IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE coexistence.%I
           ADD COLUMN IF NOT EXISTS tenant_id BIGINT
             REFERENCES coexistence.tenants(id) ON DELETE CASCADE,
           ADD COLUMN IF NOT EXISTS organization_id BIGINT
             REFERENCES coexistence.organizations(id) ON DELETE SET NULL', tbl);
      EXECUTE format('UPDATE coexistence.%I SET tenant_id = $1 WHERE tenant_id IS NULL', tbl) USING t_id;
      EXECUTE format('UPDATE coexistence.%I SET organization_id = $1 WHERE organization_id IS NULL', tbl) USING o_id;
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON coexistence.%I(tenant_id)',
                     'idx_' || tbl || '_tenant', tbl);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON coexistence.%I(organization_id)',
                     'idx_' || tbl || '_org', tbl);
    END IF;
  END LOOP;
END $$;
