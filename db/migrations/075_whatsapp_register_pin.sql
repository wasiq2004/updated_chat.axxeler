-- Finish Embedded Signup: record the Cloud API registration of a phone number.
--
-- Meta requires POST /{phone-number-id}/register with { messaging_product, pin }
-- to complete onboarding. Without it the number is connected in Business Manager
-- but CANNOT send messages via the Cloud API — which is the whole point of
-- connecting it. We generate the two-step PIN, so we must store it: Meta will ask
-- for the same PIN on re-registration (e.g. moving the number, or after Meta
-- resets registration), and a PIN nobody knows makes the number unrecoverable
-- without Meta support.
--
-- The PIN is encrypted at rest with the same AES-256-GCM helper as the access
-- token (util/crypto), never stored in plaintext.

SET search_path TO coexistence, public;

ALTER TABLE coexistence.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS two_step_pin_encrypted TEXT,
  -- NULL = never registered by us. Set on a successful /register call.
  ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ;

-- Accounts connected before this migration were added by pasting a token for a
-- number that was already registered out of band, so they are left NULL rather
-- than back-dated: we genuinely do not know their PIN, and claiming otherwise
-- would be worse than admitting it.
COMMENT ON COLUMN coexistence.whatsapp_accounts.two_step_pin_encrypted IS
  'AES-256-GCM two-step verification PIN we set during Embedded Signup registration. NULL for manually-connected numbers.';
