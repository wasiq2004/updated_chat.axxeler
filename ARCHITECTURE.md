# Zen Chat — Multi-Tenant SaaS Architecture

> Companion to [PROJECT_REQUIREMENTS.md](PROJECT_REQUIREMENTS.md). This document
> records the architecture and the **phased, incremental** plan for turning the
> existing single-tenant WhatsApp CRM into a multi-tenant SaaS platform **without
> rewriting the working feature modules**.

## 0. Approach & guardrails

- **Stack:** keep the current stack — Node/Express (CommonJS) backend, React +
  Vite frontend, PostgreSQL (`coexistence` schema), boot-time numbered-SQL
  migrations, BullMQ/Redis queues. The PRD's Next.js 15 / TypeScript stack is
  treated as aspirational; new backend modules may adopt TS later.
- **Incremental, non-breaking:** the live single-tenant app must keep working at
  every step. New tenancy columns are added **nullable + backfilled** first;
  `NOT NULL` and write-path enforcement land only after the application code
  sets them. The legacy `permissions.js` page-gate keeps running alongside the
  new DB-driven RBAC until routes are migrated over.
- **One source of truth for isolation:** every business query is scoped by
  `tenant_id` (and `organization_id` where applicable). This is enforced in a
  request-context layer, not sprinkled ad hoc.

## 1. Business hierarchy

```
Super Admin (platform)            z_chat_users.tenant_id IS NULL + role super_admin
  └─ Tenant (paying company)      tenants
       └─ Organization (brand/BU) organizations  (1 WhatsApp account each)
            └─ User                z_chat_users + user_roles (org-scoped)
```

User types map to **system roles**: `super_admin`, `tenant_admin`,
`org_manager`, `sales_user`, `support_user`.

## 2. Data model (foundation — migration `063`)

| Table | Purpose |
|---|---|
| `tenants` | paying customer; `slug`, `status`, `plan_id`, `branding` (white-label), `trial_ends_at` |
| `organizations` | business unit inside a tenant; unique `(tenant_id, slug)` |
| `permissions` | catalog of permission keys (`contacts.view`, …) — never hardcoded |
| `roles` | system roles (`tenant_id IS NULL`, `is_system`) + custom per-tenant roles |
| `role_permissions` | role → permission M:N |
| `user_roles` | user → role, optionally scoped to one `organization_id` (NULL = tenant-wide) |
| `features` | feature catalog (`inbox`, `crm`, `ai_agents`, …) |
| `plans` | `starter`/`growth`/`professional`/`enterprise` + limits (`max_users`, `max_organizations`, `max_contacts`) |
| `plan_features` | plan → feature M:N |
| `subscriptions` | tenant → plan, status, billing cycle, period, per-tenant `feature_overrides`/`limit_overrides` |
| `impersonation_sessions` | super-admin → target user, mandatory reason, expiry, IP |

`z_chat_users` gains `tenant_id` (NULL = platform super admin). The existing
`user_audit_log` is extended with `tenant_id`, `organization_id`, `ip_address`.

### Retrofit (migration `064`)
Core business tables (`contacts`, `chat_history`, `whatsapp_accounts`,
`broadcasts`, `deals`, `pipelines`, `message_templates`, `agents`, `chatbots`,
`tags`, `categories`, `contact_field_definitions`, `media_library`, `ai_models`)
get `tenant_id` (all) and `organization_id` (where org-scoped), **nullable**,
backfilled to the bootstrapped default tenant/org, with composite indexes
`(tenant_id, …)`. `NOT NULL` + FK-tightening is a later phase.

### Bootstrap / migration of existing data
`063` seeds the catalogs (permissions, features, plans, plan_features, system
roles + role_permissions) and creates a **Default Workspace** tenant + **Default**
organization on the **Enterprise** plan, so the existing install keeps every
feature. Existing users are attached to that tenant and mapped:
`admin → tenant_admin`, `bda_sales → sales_user` (default org), `viewer → support_user`.
No user is auto-promoted to `super_admin` (created explicitly later — see §8).

## 3. RBAC

Permission-based, DB-driven. Effective permissions for a request =
`union(role_permissions for the user's roles whose scope matches the active organization)`.
`requirePerm('contacts.edit')` middleware replaces page-string gates over time.
Super admin short-circuits to allow-all. Per-user JSONB grant/revoke overrides
from the legacy system are honored during the transition.

## 4. Request lifecycle (backend)

```
JWT cookie → authenticate → tenantContext → [featureGate] → [requirePerm] → handler
```

- **tenantContext** (`middleware/tenantContext.js`): resolves `req.tenant`,
  `req.organizationId` (from `X-Organization-Id`, validated against membership;
  falls back to the user's default org), and `req.isSuperAdmin`. Super admins may
  target any tenant via `X-Tenant-Id`. Attaches but does not block (phase 1).
- **rbac** (`rbac.js`): `getUserPermissions(userId, orgId)`, `requirePerm(key)`.
- **featureGate** (later): 403 when the tenant's plan lacks a feature.
- Every model/query helper takes `tenantId` and filters on it. No cross-tenant reads.

## 5. Subscriptions & feature flags

`Super Admin → feature → plan → tenant(subscription) → user(permission)`.
A feature is available to a request iff the tenant's active subscription's plan
includes it (minus `feature_overrides`). Plan **limits** (`max_users`,
`max_organizations`, `max_contacts`) are enforced at create-time with friendly 4xx.

## 6. WhatsApp BYOA

`whatsapp_accounts` already stores per-account `phone_number_id`, `waba_id`,
encrypted token. Adding `organization_id` makes each organization own its own
WABA/number; the singleton `is_default` constraint becomes per-(tenant,org). Token
encryption (`Z_CHAT_ENCRYPTION_KEY`, AES-256-GCM) and webhook-signature validation
are already in place; per-org webhook routing keys come with the BYOA phase.

## 7. Impersonation (PRD §13)

Super admin starts a session with a **mandatory reason**; a short-lived,
separately-signed impersonation JWT is issued (carries `act_as` + `imp_session_id`).
Banner + email + audit row are emitted. Blocked actions (password/billing/workspace
delete/subscription cancel/contact export) are denied while impersonating.

## 8. Phased roadmap

- **Phase 1 — Foundation (DONE):** migrations `063`/`064`, tenant-context
  middleware, DB-driven RBAC service, ARCHITECTURE.md. Non-breaking; legacy gates remain.
- **Phase 2 — Enforcement (in progress):** populate `tenant_id`/`organization_id`
  on write paths (user-create done: stamps `tenant_id` + dual-writes `user_roles`);
  remaining: flip columns to `NOT NULL`, scope every read query, retire legacy page gates.
- **Phase 3 — Super Admin (backend DONE):** `services/superAdminSeed.js`
  (`SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD`, idempotent) + `routes/platform.js`
  (tenant CRUD/suspend, plans/features, subscriptions, stats, audit), gated by
  `requireSuperAdmin`. Remaining: platform UI, revenue/usage analytics.
- **Phase 4 — Billing & limits (helpers DONE):** `services/entitlements.js`
  (`tenantHasFeature`, `checkLimit`, `featureGate`); user-limit enforced on create.
  Remaining: apply `featureGate`/limits across routes, subscription lifecycle, payments.
- **Phase 5 — Org management & BYOA:** org CRUD, per-org WhatsApp connect, org switcher.
- **Phase 6 — Impersonation, white-label, audit UI.**
- **Phase 7 — Scale/marketplace:** event-driven hooks, microservice extraction path.

## 9. Security & scale

JWT + refresh tokens, bcrypt, encrypted secrets, rate limiting, CSRF/XSS, audit
logging — tracked against PRD §16. Tenant filtering + composite `(tenant_id, …)`
indexes keep queries selective at the §17 target scale (1k tenants / 100k users /
millions of messages); BullMQ already provides queue-based horizontal scaling.
