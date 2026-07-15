-- Fixes for flaws found reviewing the self-serve signup + purchase flow.
--
--   1. Free plans must never expire.
--   2. plan_requests must snapshot the price that was agreed.
--   3. Track whether a user actually has a usable password (Facebook signups
--      don't), so we can offer "set a password" instead of stranding them.
--   4. Record terms/privacy consent at signup.
--   5. Let the verification-token table also carry password-reset tokens.

SET search_path TO coexistence, public;

-- 1. Free plans must never expire ---------------------------------------------
--
-- Signup stamped current_period_end = NOW() + 1 month on EVERY subscription,
-- including the free Starter. The sweeper never looks at price, so ~30 days
-- after signing up a free tenant went past_due, then suspended, then lost all
-- access — the entire self-serve funnel expired on a timer.
--
-- The convention already exists: subscriptionSweeper skips current_period_end
-- IS NULL ("no expiry"), which is how the bootstrap tenant is seeded. Apply it
-- to every live subscription on a zero-price plan.
UPDATE coexistence.subscriptions s
   SET current_period_end = NULL,
       status = CASE WHEN s.status IN ('past_due', 'suspended') THEN 'active' ELSE s.status END,
       updated_at = NOW()
  FROM coexistence.plans p
 WHERE p.id = s.plan_id
   AND p.price_monthly = 0
   AND s.status IN ('active', 'trialing', 'past_due', 'suspended');

-- Un-suspend any tenant that was suspended purely because its FREE plan
-- "expired". A paid tenant that lapsed is left alone — it is legitimately due.
UPDATE coexistence.tenants t
   SET status = 'active', updated_at = NOW()
  FROM coexistence.subscriptions s
  JOIN coexistence.plans p ON p.id = s.plan_id
 WHERE s.tenant_id = t.id
   AND p.price_monthly = 0
   AND t.status = 'suspended'
   AND t.deleted_at IS NULL;

-- 2. Price snapshot on plan requests ------------------------------------------
--
-- plan_requests stored only plan_id — a live FK to a mutable row. If an operator
-- edited the price between request and approval, the customer agreed to one
-- number and would be charged another, with no record of either.
ALTER TABLE coexistence.plan_requests
  ADD COLUMN IF NOT EXISTS price_at_request NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS currency_at_request TEXT;

-- Backfill existing rows from the plan's current price. Imperfect (that price
-- may already have drifted) but strictly better than NULL, and this table is
-- days old.
UPDATE coexistence.plan_requests pr
   SET price_at_request = CASE WHEN pr.billing_cycle = 'yearly' THEN p.price_yearly ELSE p.price_monthly END,
       currency_at_request = p.currency
  FROM coexistence.plans p
 WHERE p.id = pr.plan_id AND pr.price_at_request IS NULL;

-- 3. Does this account have a password its owner could actually know? ---------
--
-- A Facebook signup stores bcrypt(random bytes) to satisfy the NOT NULL column.
-- Nobody — not even us — knows that plaintext, so /auth/login can never match
-- it. Without this flag we cannot tell "chose a password" from "can never log in
-- with one", and the person is stranded the moment they lose Facebook access.
ALTER TABLE coexistence.z_chat_users
  ADD COLUMN IF NOT EXISTS password_set BOOLEAN NOT NULL DEFAULT TRUE;

-- Every account that predates this was created with a real, known password
-- (operator-provisioned or the setup wizard), so TRUE is correct for them.
-- Facebook signups are the exception and are marked at creation.
UPDATE coexistence.z_chat_users
   SET password_set = FALSE
 WHERE signup_source = 'facebook';

-- 4. Consent ------------------------------------------------------------------
ALTER TABLE coexistence.z_chat_users
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

-- 5. Reuse the token table for password resets --------------------------------
--
-- Same shape, same single-use + expiry semantics, same hashing. A separate table
-- would duplicate all of it. 'verify' keeps existing rows behaving exactly as
-- they did.
ALTER TABLE coexistence.email_verification_tokens
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'verify';

ALTER TABLE coexistence.email_verification_tokens
  DROP CONSTRAINT IF EXISTS email_verification_tokens_purpose_check;
ALTER TABLE coexistence.email_verification_tokens
  ADD CONSTRAINT email_verification_tokens_purpose_check
  CHECK (purpose IN ('verify', 'reset'));

-- The old index assumed one live token per user; there can now be one per
-- purpose (a pending verification AND a pending reset).
DROP INDEX IF EXISTS coexistence.idx_email_verif_user;
CREATE INDEX IF NOT EXISTS idx_email_verif_user_purpose
  ON coexistence.email_verification_tokens (user_id, purpose) WHERE consumed_at IS NULL;
