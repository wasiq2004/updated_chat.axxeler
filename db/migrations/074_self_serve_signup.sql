-- Self-serve signup: email verification, signup attribution, and plan requests.
--
-- Until now every account was provisioned by an operator above it (platform
-- super admin -> tenant, reseller admin -> tenant, tenant admin -> user). This
-- adds the pieces a public "create account" flow needs:
--
--   1. email_verified_at + verification tokens — prove the address is real.
--   2. signup_source — so the console can tell a self-serve or Facebook signup
--      apart from an operator-provisioned account.
--   3. plan_requests — there is no payment gateway; a customer picking a paid
--      plan records an intent that an operator approves after collecting
--      payment out of band. This is the "purchase" step until a gateway exists.

SET search_path TO coexistence, public;

-- 1. Email verification -------------------------------------------------------

ALTER TABLE coexistence.z_chat_users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  -- 'invite'     — created by an operator (the only path that existed before)
  -- 'self_serve' — public signup form
  -- 'facebook'   — public signup via Sign in with Facebook
  ADD COLUMN IF NOT EXISTS signup_source TEXT NOT NULL DEFAULT 'invite';

-- Backfill: every account that already exists was vouched for by an operator.
-- Without this, adding a verification gate would lock out the entire install on
-- the next deploy. Only rows predating this migration are touched (new signups
-- insert with email_verified_at NULL and must verify).
UPDATE coexistence.z_chat_users
   SET email_verified_at = COALESCE(created_at, NOW())
 WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS coexistence.email_verification_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES coexistence.z_chat_users(id) ON DELETE CASCADE,
  -- SHA-256 of the emailed token. The raw value is never stored: a database
  -- leak must not hand out working verification links.
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verif_user
  ON coexistence.email_verification_tokens (user_id) WHERE consumed_at IS NULL;

-- 2. Plan requests (the stand-in for checkout) --------------------------------

CREATE TABLE IF NOT EXISTS coexistence.plan_requests (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES coexistence.tenants(id) ON DELETE CASCADE,
  plan_id       BIGINT NOT NULL REFERENCES coexistence.plans(id)   ON DELETE CASCADE,
  billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','yearly')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  note          TEXT,
  requested_by  BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL,
  decided_by    BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live request per tenant: re-requesting replaces the pending one rather
-- than queueing duplicates for the operator to sort out.
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_requests_one_pending
  ON coexistence.plan_requests (tenant_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_plan_requests_pending
  ON coexistence.plan_requests (created_at DESC) WHERE status = 'pending';
