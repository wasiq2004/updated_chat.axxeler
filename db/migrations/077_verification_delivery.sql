-- Record whether the verification email actually reached the person.
--
-- Configuring SMTP turns the verification gate ON. If the mailer is then broken
-- (a rejected API key, an unverified sender domain), signup becomes a TRAP: the
-- account is created, the email silently fails, the person can't log in, and
-- "Resend the link" fails identically. They have no way forward and the operator
-- has no way to know it is happening — the failure only ever appeared in a
-- server log line nobody reads.
--
-- Storing the delivery outcome turns that dead end into a support task: the
-- console can list who is stuck, say why, and let an operator verify them by
-- hand.

SET search_path TO coexistence, public;

ALTER TABLE coexistence.z_chat_users
  ADD COLUMN IF NOT EXISTS verification_sent_at TIMESTAMPTZ,
  -- NULL = the last attempt succeeded (or none was made). Non-NULL = the mailer
  -- rejected it, and this is the provider's own reason, shown to the operator.
  ADD COLUMN IF NOT EXISTS verification_error TEXT,
  -- Who let them in without confirming the address, if anyone. Keeps a manual
  -- verification attributable rather than indistinguishable from a real one.
  ADD COLUMN IF NOT EXISTS verified_by BIGINT REFERENCES coexistence.z_chat_users(id) ON DELETE SET NULL;

-- Finding the people who are stuck: self-serve signups that never confirmed.
-- Partial, because this is a small set against a table we read constantly.
CREATE INDEX IF NOT EXISTS idx_users_unverified
  ON coexistence.z_chat_users (created_at DESC)
  WHERE email_verified_at IS NULL AND signup_source = 'self_serve';
