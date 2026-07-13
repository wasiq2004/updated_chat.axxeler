-- Facebook / Meta Embedded Signup support.
--
-- Two additions:
--   1. whatsapp_accounts.connection_method — how the number was connected:
--        'manual'          = admin pasted Phone Number ID + token (legacy form)
--        'embedded_signup' = connected via Facebook Business Login (Embedded
--                            Signup). Surfaced to admins/super-admins as a
--                            "Connected via Facebook" badge.
--   2. z_chat_users.fb_user_id — the person's Facebook app-scoped user id,
--      captured (server-verified) when they connect WhatsApp via Facebook. Lets
--      a returning user sign in directly with the "Sign in with Facebook" button
--      on the login page. NULL for accounts that never linked Facebook.

SET search_path TO coexistence, public;

-- ── How a WhatsApp account was connected ──────────────────────────────────────
ALTER TABLE coexistence.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS connection_method TEXT NOT NULL DEFAULT 'manual';

-- ── Facebook identity link for direct login ───────────────────────────────────
ALTER TABLE coexistence.z_chat_users
  ADD COLUMN IF NOT EXISTS fb_user_id TEXT;

-- One Facebook identity maps to at most one Z-Chat account (partial unique so the
-- many NULLs don't collide). Also the lookup index for the login path.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_z_chat_users_fb_user_id
  ON coexistence.z_chat_users(fb_user_id) WHERE fb_user_id IS NOT NULL;
