-- 063: Multi-tenant SaaS foundation.
--
-- Introduces the platform hierarchy (Tenant → Organization → User), DB-driven
-- RBAC (permissions / roles / role_permissions / user_roles), the subscription
-- + feature-flag catalog (features / plans / plan_features / subscriptions), and
-- impersonation sessions. Seeds the permission/feature/plan catalogs and the
-- system roles, then bootstraps a "Default Workspace" tenant + "Default"
-- organization on the Enterprise plan and migrates the existing single-tenant
-- install onto it (every current user is attached to the default tenant and
-- given an equivalent role).
--
-- NON-BREAKING: this migration only ADDS tables/columns and seed data. The live
-- app keeps using the legacy permissions.js page gate; the new RBAC tables are
-- populated but not yet enforced (see ARCHITECTURE.md, Phase 2). Targets
-- PostgreSQL 15 (uses UNIQUE NULLS NOT DISTINCT).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Catalogs: permissions & features
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.permissions (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,           -- e.g. 'contacts.view'
  category    TEXT,                           -- grouping for UI (e.g. 'contacts')
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coexistence.features (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,           -- e.g. 'ai_agents'
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Plans & feature mapping
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.plans (
  id                BIGSERIAL PRIMARY KEY,
  key               TEXT NOT NULL UNIQUE,     -- 'starter' | 'growth' | 'professional' | 'enterprise'
  name              TEXT NOT NULL,
  description       TEXT,
  price_monthly     NUMERIC(12,2) NOT NULL DEFAULT 0,
  price_yearly      NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  -- NULL limit = unlimited
  max_users         INT,
  max_organizations INT,
  max_contacts      INT,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  position          INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coexistence.plan_features (
  plan_id    BIGINT NOT NULL REFERENCES coexistence.plans(id) ON DELETE CASCADE,
  feature_id BIGINT NOT NULL REFERENCES coexistence.features(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, feature_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Tenants & organizations
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.tenants (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','trial','suspended','cancelled')),
  plan_id       BIGINT REFERENCES coexistence.plans(id) ON DELETE SET NULL,
  branding      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- white-label (logo, colors, domain)
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  trial_ends_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- z_chat_users already exists (migrations 000/058) so these FKs are inlined;
  -- ADD CONSTRAINT has no IF NOT EXISTS form, and the migration runner applies
  -- each file exactly once, so inlining keeps the file safely re-runnable.
  created_by    BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL,
  updated_by    BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL,
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON coexistence.tenants(status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS coexistence.organizations (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES coexistence.tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL,
  updated_by  BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL,
  deleted_at  TIMESTAMPTZ,
  UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_organizations_tenant ON coexistence.organizations(tenant_id);

-- A user belongs to one tenant (NULL = platform super admin, no tenant).
ALTER TABLE coexistence.z_chat_users
  ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES coexistence.tenants(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_users_tenant ON coexistence.z_chat_users(tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Roles & assignments (RBAC)
-- ─────────────────────────────────────────────────────────────────────────────
-- System roles have tenant_id NULL + is_system=true. Custom roles belong to a tenant.
CREATE TABLE IF NOT EXISTS coexistence.roles (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT REFERENCES coexistence.tenants(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,                  -- 'tenant_admin', etc.
  name        TEXT NOT NULL,
  description TEXT,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- (tenant_id, key) unique; NULLS NOT DISTINCT so system roles can't be duplicated.
  UNIQUE NULLS NOT DISTINCT (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS coexistence.role_permissions (
  role_id       BIGINT NOT NULL REFERENCES coexistence.roles(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES coexistence.permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- A user holds a role, optionally scoped to a single organization
-- (organization_id NULL = applies tenant-wide / all orgs).
CREATE TABLE IF NOT EXISTS coexistence.user_roles (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES coexistence.z_chat_users(id) ON DELETE CASCADE,
  role_id         BIGINT NOT NULL REFERENCES coexistence.roles(id) ON DELETE CASCADE,
  organization_id BIGINT REFERENCES coexistence.organizations(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL,
  UNIQUE NULLS NOT DISTINCT (user_id, role_id, organization_id)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON coexistence.user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_org  ON coexistence.user_roles(organization_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Subscriptions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.subscriptions (
  id                   BIGSERIAL PRIMARY KEY,
  tenant_id            BIGINT NOT NULL REFERENCES coexistence.tenants(id) ON DELETE CASCADE,
  plan_id              BIGINT NOT NULL REFERENCES coexistence.plans(id) ON DELETE RESTRICT,
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','trialing','past_due','cancelled','suspended')),
  billing_cycle        TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','yearly')),
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  feature_overrides    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { "ai_agents": true/false }
  limit_overrides      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { "max_users": 50 }
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON coexistence.subscriptions(tenant_id);
-- At most one live subscription per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_live
  ON coexistence.subscriptions(tenant_id)
  WHERE status IN ('active','trialing','past_due');

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Impersonation sessions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coexistence.impersonation_sessions (
  id             BIGSERIAL PRIMARY KEY,
  super_admin_id BIGINT NOT NULL REFERENCES coexistence.z_chat_users(id) ON DELETE CASCADE,
  target_user_id BIGINT NOT NULL REFERENCES coexistence.z_chat_users(id) ON DELETE CASCADE,
  tenant_id      BIGINT REFERENCES coexistence.tenants(id) ON DELETE SET NULL,
  reason         TEXT NOT NULL,
  ip_address     TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_impersonation_super ON coexistence.impersonation_sessions(super_admin_id);
CREATE INDEX IF NOT EXISTS idx_impersonation_active
  ON coexistence.impersonation_sessions(target_user_id) WHERE ended_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Extend the existing audit log with tenant/org/IP context
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE coexistence.user_audit_log
  ADD COLUMN IF NOT EXISTS tenant_id       BIGINT REFERENCES coexistence.tenants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS organization_id BIGINT REFERENCES coexistence.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ip_address      TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON coexistence.user_audit_log(tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Seed permission catalog
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO coexistence.permissions (key, category, description) VALUES
  ('inbox.view',          'inbox',        'View the shared inbox / conversations'),
  ('inbox.send',          'inbox',        'Send messages in conversations'),
  ('contacts.view',       'contacts',     'View contacts'),
  ('contacts.create',     'contacts',     'Create contacts'),
  ('contacts.edit',       'contacts',     'Edit contacts'),
  ('contacts.delete',     'contacts',     'Delete contacts'),
  ('contacts.export',     'contacts',     'Export contacts'),
  ('deals.view',          'deals',        'View deals / pipelines'),
  ('deals.create',        'deals',        'Create deals'),
  ('deals.edit',          'deals',        'Edit deals'),
  ('deals.delete',        'deals',        'Delete deals'),
  ('campaigns.view',      'campaigns',    'View campaigns / broadcasts'),
  ('campaigns.create',    'campaigns',    'Create campaigns'),
  ('campaigns.run',       'campaigns',    'Run / send campaigns'),
  ('templates.view',      'templates',    'View message templates'),
  ('templates.manage',    'templates',    'Create / edit / submit templates'),
  ('automations.view',    'automations',  'View automations'),
  ('automations.manage',  'automations',  'Create / edit automations'),
  ('ai_agents.view',      'ai_agents',    'View AI agents'),
  ('ai_agents.manage',    'ai_agents',    'Create / edit AI agents'),
  ('analytics.view',      'analytics',    'View analytics dashboards'),
  ('users.view',          'users',        'View users'),
  ('users.manage',        'users',        'Create / edit / remove users and roles'),
  ('integrations.manage', 'settings',     'Manage integrations (Google, WhatsApp, MCP)'),
  ('settings.manage',     'settings',     'Manage tenant/org settings'),
  ('billing.manage',      'billing',      'Manage subscription & billing'),
  ('organizations.view',  'organizations','View organizations'),
  ('organizations.manage','organizations','Create / edit organizations'),
  ('audit.view',          'audit',        'View audit logs'),
  -- platform-only (super admin)
  ('platform.tenants.manage',  'platform', 'Create / suspend / manage tenants'),
  ('platform.plans.manage',    'platform', 'Manage plans & features'),
  ('platform.analytics.view',  'platform', 'View platform & revenue analytics'),
  ('platform.impersonate',     'platform', 'Impersonate tenant users'),
  ('platform.audit.view',      'platform', 'View platform-wide audit logs')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Seed feature catalog
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO coexistence.features (key, name, description) VALUES
  ('inbox',       'Inbox',       'Shared team inbox'),
  ('crm',         'CRM',         'Contacts & customer management'),
  ('deals',       'Deals',       'Sales pipelines & deals'),
  ('campaigns',   'Campaigns',   'Broadcast & scheduled campaigns'),
  ('broadcast',   'Broadcast',   'Bulk broadcast messaging'),
  ('ai_agents',   'AI Agents',   'AI chat assistants'),
  ('automations', 'Automations', 'Workflow automation engine'),
  ('analytics',   'Analytics',   'Analytics & reporting'),
  ('api_access',  'API Access',  'Programmatic API access'),
  ('webhooks',    'Webhooks',    'Outbound webhooks'),
  ('white_label', 'White Label', 'Custom branding & domain'),
  ('marketplace', 'Marketplace', 'App marketplace')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Seed plans + plan_features
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO coexistence.plans (key, name, description, price_monthly, max_users, max_organizations, max_contacts, position) VALUES
  ('starter',      'Starter',      'Inbox, contacts, basic CRM',                          0,    5,    1,    1000,  0),
  ('growth',       'Growth',       'CRM, campaigns, automations',                         49,   20,   5,    10000, 1),
  ('professional', 'Professional', 'CRM, campaigns, automations, AI agents, API',         149,  100,  20,   NULL,  2),
  ('enterprise',   'Enterprise',   'Unlimited, white-label, custom integrations',         0,    NULL, NULL, NULL,  3)
ON CONFLICT (key) DO NOTHING;

-- Map features → plans (cumulative tiers).
DO $$
DECLARE
  starter      BIGINT := (SELECT id FROM coexistence.plans WHERE key = 'starter');
  growth       BIGINT := (SELECT id FROM coexistence.plans WHERE key = 'growth');
  professional BIGINT := (SELECT id FROM coexistence.plans WHERE key = 'professional');
  enterprise   BIGINT := (SELECT id FROM coexistence.plans WHERE key = 'enterprise');
  fid          BIGINT;
BEGIN
  -- Starter: inbox, crm
  FOR fid IN SELECT id FROM coexistence.features WHERE key IN ('inbox','crm') LOOP
    INSERT INTO coexistence.plan_features (plan_id, feature_id) VALUES (starter, fid) ON CONFLICT DO NOTHING;
  END LOOP;
  -- Growth: + deals, campaigns, broadcast, automations, analytics
  FOR fid IN SELECT id FROM coexistence.features WHERE key IN
    ('inbox','crm','deals','campaigns','broadcast','automations','analytics') LOOP
    INSERT INTO coexistence.plan_features (plan_id, feature_id) VALUES (growth, fid) ON CONFLICT DO NOTHING;
  END LOOP;
  -- Professional: + ai_agents, api_access, webhooks
  FOR fid IN SELECT id FROM coexistence.features WHERE key IN
    ('inbox','crm','deals','campaigns','broadcast','automations','analytics','ai_agents','api_access','webhooks') LOOP
    INSERT INTO coexistence.plan_features (plan_id, feature_id) VALUES (professional, fid) ON CONFLICT DO NOTHING;
  END LOOP;
  -- Enterprise: everything
  FOR fid IN SELECT id FROM coexistence.features LOOP
    INSERT INTO coexistence.plan_features (plan_id, feature_id) VALUES (enterprise, fid) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Seed system roles + their permissions
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO coexistence.roles (tenant_id, key, name, description, is_system) VALUES
  (NULL, 'super_admin',   'Super Admin',          'Platform owner — full access to all tenants', TRUE),
  (NULL, 'tenant_admin',  'Tenant Admin',         'Manages the entire tenant',                   TRUE),
  (NULL, 'org_manager',   'Organization Manager', 'Manages an assigned organization',            TRUE),
  (NULL, 'sales_user',    'Sales User',           'Handles customer communication',              TRUE),
  (NULL, 'support_user',  'Support User',         'Limited support access',                      TRUE)
ON CONFLICT (tenant_id, key) DO NOTHING;

DO $$
DECLARE
  super_admin  BIGINT := (SELECT id FROM coexistence.roles WHERE key = 'super_admin'  AND tenant_id IS NULL);
  tenant_admin BIGINT := (SELECT id FROM coexistence.roles WHERE key = 'tenant_admin' AND tenant_id IS NULL);
  org_manager  BIGINT := (SELECT id FROM coexistence.roles WHERE key = 'org_manager'  AND tenant_id IS NULL);
  sales_user   BIGINT := (SELECT id FROM coexistence.roles WHERE key = 'sales_user'   AND tenant_id IS NULL);
  support_user BIGINT := (SELECT id FROM coexistence.roles WHERE key = 'support_user' AND tenant_id IS NULL);
  pid          BIGINT;
BEGIN
  -- super_admin: every permission.
  FOR pid IN SELECT id FROM coexistence.permissions LOOP
    INSERT INTO coexistence.role_permissions (role_id, permission_id) VALUES (super_admin, pid) ON CONFLICT DO NOTHING;
  END LOOP;

  -- tenant_admin: everything except platform-only permissions.
  FOR pid IN SELECT id FROM coexistence.permissions WHERE category <> 'platform' LOOP
    INSERT INTO coexistence.role_permissions (role_id, permission_id) VALUES (tenant_admin, pid) ON CONFLICT DO NOTHING;
  END LOOP;

  -- org_manager: operational management within an org (no billing/users.manage/org.manage).
  FOR pid IN SELECT id FROM coexistence.permissions WHERE key IN (
    'inbox.view','inbox.send','contacts.view','contacts.create','contacts.edit','contacts.delete',
    'deals.view','deals.create','deals.edit','deals.delete','campaigns.view','campaigns.create','campaigns.run',
    'templates.view','templates.manage','automations.view','automations.manage','ai_agents.view','ai_agents.manage',
    'analytics.view','users.view','integrations.manage','organizations.view'
  ) LOOP
    INSERT INTO coexistence.role_permissions (role_id, permission_id) VALUES (org_manager, pid) ON CONFLICT DO NOTHING;
  END LOOP;

  -- sales_user: day-to-day selling.
  FOR pid IN SELECT id FROM coexistence.permissions WHERE key IN (
    'inbox.view','inbox.send','contacts.view','contacts.create','contacts.edit',
    'deals.view','deals.create','deals.edit','campaigns.view','templates.view','analytics.view'
  ) LOOP
    INSERT INTO coexistence.role_permissions (role_id, permission_id) VALUES (sales_user, pid) ON CONFLICT DO NOTHING;
  END LOOP;

  -- support_user: read-mostly.
  FOR pid IN SELECT id FROM coexistence.permissions WHERE key IN (
    'inbox.view','inbox.send','contacts.view','deals.view'
  ) LOOP
    INSERT INTO coexistence.role_permissions (role_id, permission_id) VALUES (support_user, pid) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. Bootstrap default tenant/org and migrate existing users
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  ent_plan     BIGINT := (SELECT id FROM coexistence.plans WHERE key = 'enterprise');
  tenant_admin BIGINT := (SELECT id FROM coexistence.roles WHERE key = 'tenant_admin' AND tenant_id IS NULL);
  org_manager  BIGINT := (SELECT id FROM coexistence.roles WHERE key = 'org_manager'  AND tenant_id IS NULL);
  sales_user   BIGINT := (SELECT id FROM coexistence.roles WHERE key = 'sales_user'   AND tenant_id IS NULL);
  support_user BIGINT := (SELECT id FROM coexistence.roles WHERE key = 'support_user' AND tenant_id IS NULL);
  t_id         BIGINT;
  o_id         BIGINT;
BEGIN
  -- Only bootstrap once (idempotent on the 'default' slug).
  SELECT id INTO t_id FROM coexistence.tenants WHERE slug = 'default';
  IF t_id IS NULL THEN
    INSERT INTO coexistence.tenants (name, slug, status, plan_id)
      VALUES ('Default Workspace', 'default', 'active', ent_plan)
      RETURNING id INTO t_id;
  END IF;

  SELECT id INTO o_id FROM coexistence.organizations WHERE tenant_id = t_id AND slug = 'default';
  IF o_id IS NULL THEN
    INSERT INTO coexistence.organizations (tenant_id, name, slug, status)
      VALUES (t_id, 'Default', 'default', 'active')
      RETURNING id INTO o_id;
  END IF;

  -- Enterprise subscription for the default tenant (if none live yet).
  IF NOT EXISTS (
    SELECT 1 FROM coexistence.subscriptions
     WHERE tenant_id = t_id AND status IN ('active','trialing','past_due')
  ) THEN
    INSERT INTO coexistence.subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_start)
      VALUES (t_id, ent_plan, 'active', 'monthly', NOW());
  END IF;

  -- Attach every existing user to the default tenant.
  UPDATE coexistence.z_chat_users SET tenant_id = t_id WHERE tenant_id IS NULL;

  -- Map legacy roles → system roles. Admin = tenant-wide; others scoped to default org.
  INSERT INTO coexistence.user_roles (user_id, role_id, organization_id)
    SELECT u.id, tenant_admin, NULL FROM coexistence.z_chat_users u WHERE u.role = 'admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO coexistence.user_roles (user_id, role_id, organization_id)
    SELECT u.id, sales_user, o_id FROM coexistence.z_chat_users u WHERE u.role = 'bda_sales'
  ON CONFLICT DO NOTHING;

  INSERT INTO coexistence.user_roles (user_id, role_id, organization_id)
    SELECT u.id, support_user, o_id FROM coexistence.z_chat_users u WHERE u.role = 'viewer'
  ON CONFLICT DO NOTHING;
END $$;
