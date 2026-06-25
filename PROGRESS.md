# SaaS Transformation — Progress Checkpoint

> Living checkpoint so work can resume without re-deriving state. Updated as each
> unit lands. Authoritative design: [ARCHITECTURE.md](ARCHITECTURE.md). Requirements:
> [PROJECT_REQUIREMENTS.md](PROJECT_REQUIREMENTS.md).

## ✅ LIVE-VERIFIED (Postgres 15 + Redis via Docker, real app boot)
Booted `node src/index.js` against a throwaway Postgres 15 + Redis. Confirmed:
- All 65 migrations apply cleanly (fixed a real bug in 064 — ambiguous `id`); super-admin seeded; `[Zen Chat] Backend running`.
- `/health`, `/api/auth/status`, login, `/api/auth/me` (returns `isSuperAdmin`/`tenantId`) all work.
- `/api/platform/stats`, `/api/platform/tenants` (create provisions tenant+org+subscription), plans — all work.
- **Tenant-admin writes are stamped** (`QA Pipeline t=1 o=1`).
- **Cross-tenant isolation PROVEN**: a tenant-2 pipeline is invisible to the tenant-1 admin's `GET /pipelines`.
- **Impersonation** start/stop works; session `ended_at` set; audit log records create/start/stop.

### Bugs found & fixed via live testing
1. `064` — ambiguous `id` in the org subquery → qualified to `o.id`. ✅ fixed
2. **Fresh-install orphan admin** — the first admin is created AFTER migrations, so it had `tenant_id NULL` + no role, and its data was stamped NULL. Added `services/tenantBootstrap.js` (`attachOrphanUsers`, wired into boot after seedSuperAdmin) → admin now gets `tenant_id` + `tenant_admin`. ✅ fixed & re-verified

### Known local-dev gotcha (NOT a production issue)
- A stray partial `backend/db/migrations/` (only 056–060) makes the migrate runner pick the wrong dir on a bare `node src/index.js`. Docker resolves `/app/db/migrations` correctly. Local workaround: `MIGRATIONS_DIR=<repo>/db/migrations`. (Left as-is — pre-existing; flag to user.)
- Pre-existing non-fatal `express-rate-limit` v7 IPv6 keyGenerator validation warning at index.js:110 (unrelated to SaaS work).

- Rule: never assume a symbol/column/route exists — read the file first.

## Status legend: ✅ done & node-checked · 🟡 partial · ⬜ todo · ⚠️ needs live test

## Backend
- ✅ Migration `063_saas_foundation.sql` — tenants, organizations, RBAC, plans/features/subscriptions, impersonation_sessions, seeds + default tenant/org bootstrap
- ✅ Migration `064_tenant_scope_backfill.sql` — nullable tenant_id/org_id on 18 business tables + backfill
- ✅ `middleware/tenantContext.js` — resolves req.tenantId/organizationId/isSuperAdmin (non-blocking)
- ✅ `rbac.js` — getUserPermissions, userHasPermission, requirePerm, requireSuperAdmin
- ✅ `services/superAdminSeed.js` — env-driven idempotent super-admin seed
- ✅ `services/entitlements.js` — tenantHasFeature, checkLimit, featureGate
- ✅ `routes/platform.js` — super-admin tenant/plan/subscription/stats/audit API
- ✅ `routes/users.js` — create stamps tenant_id, dual-writes user_roles, enforces user limit
- ✅ `routes/organizations.js` — tenant-scoped org CRUD + member counts, org-limit enforced
- ✅ Impersonation backend — `routes/impersonation.js` (start super-admin/stop), scoped JWT with `imp` claim, `blockDuringImpersonation` guard (applied to user reset-password + delete), audit
- ✅ `auth.js` — exported `signToken(extraClaims,expiresIn)`, `setAuthCookie`, `loadUserSession`; login uses helper
- ✅ `middleware/access.js` — `auditLog` now writes tenant_id/org_id/ip; added `blockDuringImpersonation`
- ⚠️ Apply `featureGate` to feature routers — DEFERRED: gating blind could 403 a tenant with no subscription row; apply in Phase 4 with a live test
- 🟡 Phase 2 tenant-scoping (in progress) — helper `scopeClause(req,alias,params,{leading})` in access.js (no-op when no tenant, so single-tenant app unaffected). Done:
  - ✅ pipelines.js — every pipeline/stage/deal query scoped + writes stamped (reference vertical)
  - ✅ broadcasts.js — list/get/create/update/delete/send/test scoped; broadcast_logs stamped
  - ✅ templates.js — list/get/create/update/delete/duplicate scoped + stamped; Meta-sync import stamps tenant from account
  - ✅ agents.js — list/get/create/update/delete/export/import scoped + stamped
  - ✅ whatsappAccounts.js — list/get/create/update/delete scoped + stamped (internal getAccountWithToken/byPhone left unscoped — used by webhook/workers)
  - ✅ messages.js — /numbers, /contacts, /saved-contacts, /contact-names scoped; /contacts/save stamps tenant/org
  - ✅ chatbots.js — list/get/create/update/duplicate/export/import/delete scoped + stamped
  - ✅ categories.js — categories + tags: list/create/update/delete scoped + stamped
  - ✅ contactFields.js — list/create/update/delete scoped + stamped (tenant_id only)
  - ✅ aiModels.js — list/get/create/update/delete scoped + stamped (incl. agent-demote on delete)
  - ✅ mediaLibrary.js — list + upload scoped + stamped; default-account fallback scoped
  - ✅ dashboard.js — analytics scoped (applyScope tenant clause + getConnectedWa(tenantId) + admin aggregates). LIVE-tested. (automation_executions lacks tenant_id → run-count aggregate unscoped; noted)
  - ✅ messages.js /messages thread scoped + central `assertWaAccess`/`assertContactAccess` made tenant-aware for admins (`waInTenant`). LIVE: admin reads own convo; **403 on cross-tenant**.
  - ✅ WRITE PATHS stamped: webhook.js (chat_history + contacts via phone_number_id→account), messageSender.js insertPendingRow, automationEngine.js (3 upserts), messages.js bulk-import. LIVE: simulated inbound webhook → tenant_id stamped → visible in scoped /messages,/numbers,/contacts.
  - ✅ by-id mutations scoped: media-library PUT/DELETE, template submit/sync/payload/test-send
  - ✅ Migration `065_per_tenant_default_account.sql` — global is_default unique → per-tenant; create sets default per-tenant. LIVE: two tenants each hold their own default.
  - DECISION: **tenant_id/org_id kept NULLABLE (NOT flipped to NOT NULL).** Webhook/send derive tenant_id from the account via subquery; if any account were unstamped, NOT NULL would *reject inbound WhatsApp messages = data loss*. Nullable + scoping degrades gracefully. Not worth the risk on a live messaging system.
  - ✅ Residual scoping DONE: migration `066_automation_executions_tenant.sql` adds tenant_id (backfilled from chatbot) + stamped on insert; dashboard run-count, chatbots `/:id/executions` + `/executions/:id` + cancel scoped; agent `/:id/tools` (POST/PUT/DELETE) & `/:id/runs` (GET/GET) guarded by `agentInTenant`. LIVE-verified (200/404, no 500s).

## Phase 4 — Feature gating + plan limits (✅ DONE, LIVE-verified)
- `featureGate(key)` from `services/entitlements.js` mounted in index.js on premium routers: broadcasts→`campaigns`, chatbots→`automations`, agents+agentConversation→`ai_agents`. Core (inbox/CRM/templates/dashboard) ungated.
- LIVE TEST: default tenant on **Enterprise** → /agents,/broadcasts,/chatbots = 200. Super admin downgraded tenant to **Starter** via `POST /platform/tenants/1/subscription` → all three = **403**; restore Enterprise → 200 again.
- Plan limit `max_contacts` enforced on `/contacts/import` (checkLimit, fail-open). (`max_users` on user-create and `max_organizations` on org-create were already enforced.)
- ✅ Phase 4 frontend feature-gating UX (DONE, build-verified + backend live-verified):
  - Backend `GET /api/billing/entitlements` (routes/billing.js) — tenant plan, enabled features, limits+usage, full plan catalog; super-admin = all-access. `getTenantFeatures()` added to entitlements.js.
  - **BUG FIXED**: `app.use('/api', featureGate(k), router)` leaked the gate to every later /api route (on Starter the billing endpoint itself 403'd). Switched to PATH-SCOPED gates: `app.use('/api/broadcasts', featureGate('campaigns'))`, `app.use(['/api/chatbots','/api/executions'], featureGate('automations'))`, `app.use(['/api/agents','/api/agent-conversation'], featureGate('ai_agents'))`. LIVE-verified: on Starter, gated routes 403 while billing/organizations/templates = 200.
  - Frontend: `lib/plans.js` (page→feature map, FEATURE/PLAN metadata, hasFeature/canAccessPage), `components/UpgradeGate.jsx` (premium lock screen), `pages/BillingPage.jsx` (current plan + animated usage meters + plan comparison grid). App.jsx fetches entitlements on user change, renders UpgradeGate for gated pages, adds `billing` route. Sidebar shows a 🔒 on locked items + a "Plan" nav entry. `vite build` passes.
- ⬜ Phase 4 remaining: payment-provider/self-serve checkout (currently "contact your account manager"); plan changes are super-admin-driven via platform API.

## Phase 5 — Organizations + per-org data scoping (✅ DONE, LIVE-verified)
- tenantContext tracks `req.orgExplicit` (true only when X-Organization-Id was deliberately set). `orgScope(req,alias,params)` helper (access.js) — filters by organization_id ONLY when explicit, else no-op ("All organizations" = tenant-wide).
- orgScope applied to the LIST reads of: whatsapp_accounts, /numbers (inbox), pipelines, deals (+metrics), broadcasts, agents, chatbots, templates, media, categories, tags. Writes already stamp organization_id from req.organizationId.
- Migration 065 already gives per-tenant default WhatsApp account; org create assigns the account to the selected org.
- Frontend: `components/OrgSwitcher.jsx` (Topbar dropdown: All organizations / each org / Manage), `pages/OrganizationsPage.jsx` (CRUD), App.jsx holds activeOrg, persists X-Organization-Id (api.setActiveOrg), remounts page on switch (`key={page:org}`).
- LIVE: 2 orgs each with their own WhatsApp account → all-orgs shows both, org1 header shows only Org1's, org2 only Org2's.

## Phase 6 — White-label + Audit + Impersonation UI (✅ DONE, LIVE-verified)
- Backend: `routes/audit.js` GET /audit (tenant-scoped, audit.view); `routes/branding.js` GET/PATCH /branding (PATCH needs settings.manage + white_label feature → 403 otherwise); `GET /platform/tenants/:id/users` (impersonation picker); branding + tenantName added to /billing/entitlements.
- Frontend: white-label applied at runtime (entitlements.branding.primaryColor overrides --c-primary; logo/brandName in Topbar). `pages/BrandingPage.jsx` (white-label studio w/ live preview, gated via PAGE_FEATURE branding→white_label so non-white-label tenants see UpgradeGate). `pages/AuditPage.jsx` (filterable audit table). SuperAdminPage Tenants tab → "Impersonate" button → ImpersonateModal (lists tenant users, prompts reason, calls api.platform.impersonate, reloads into the impersonated session; banner already exists). User menu gains Plan / Organizations / White-label / Audit log for admins.
- LIVE: branding PATCH saves on Enterprise, 403 on Starter; audit log returns scoped entry; tenant users + impersonation start verified (/auth/me shows imp by owner). vite build passes.
  - VERIFY: all changed files pass `node --check`; **LIVE-tested** vs Postgres 15 + Redis (full inbound pipeline, cross-tenant 403, per-tenant default, 13 endpoints → 200).

## Frontend  (✅ `vite build` passes — JSX compiles)
- ✅ `pages/SuperAdminPage.jsx` — Overview/Tenants/Plans/Audit; create tenant, suspend/activate, change plan. Wired into `App.jsx` (route `super-admin`, gated by `user.isSuperAdmin`, sidebar hidden, full-width)
- ✅ Impersonation banner + "Stop impersonating" + "Platform owner mode" bar in `App.jsx`
- ✅ `api.js` — `api.platform.*`, `api.organizations.*`, `api.stopImpersonation`, `setActiveOrg/getActiveOrg` + `X-Organization-Id` header on every `req()`
- ✅ `auth.js loadUserSession` now returns `isSuperAdmin` + `tenantId`; `/auth/me` surfaces `impersonation`
- ⬜ Org switcher UI (header plumbing done; dropdown not built — only 1 default org exists)
- ⬜ Plan/limit upgrade prompts; Tenant-admin Organizations management page

## Verification done this session
- `node --check` ✅ on all 11 changed/new backend files
- `vite build` ✅ (1814 modules) — frontend compiles with new console
- Static SQL review ✅ (migrations 063/064). LIVE apply/boot STILL UNVERIFIED.

## Work log
- checkpoint created; backend foundation + platform API in place.
- Added organizations API, impersonation backend, audit tenant/org/ip, impersonation guard.
- Added Super Admin frontend console, impersonation banner, org-header plumbing; session exposes isSuperAdmin.
- All JS node-checked; frontend vite build passes.

## Hand-off: needs a LIVE environment (cannot be done safely/blind here)
1. `cd backend && npm install`; boot against Postgres 15 → confirms migrations 063/064 apply + app boots.
2. Set `SUPER_ADMIN_EMAIL` + `SUPER_ADMIN_PASSWORD` once → log in → verify Super Admin console + impersonation.
3. **Phase 2 read-scoping** (HIGH RISK): add `tenant_id` to every existing read/write query, then flip columns to `NOT NULL`. Must be done per-module WITH the app running and tested to avoid cross-tenant leakage / breaking the live app.
4. Apply `featureGate(...)` / `checkLimit(...)` across feature routers once a multi-plan tenant exists to test against.
