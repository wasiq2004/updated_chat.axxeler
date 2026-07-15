// Email verification for self-serve signups.
//
// Deliberate behaviour: verification is only ENFORCED when SMTP is configured.
// This install ships with no SMTP_HOST, and a hard gate would mean nobody could
// ever complete a signup — the account would be created and then be unusable
// with no way to unlock it. So when there is no mailer, a signup is verified on
// creation. Setting SMTP_HOST turns the gate on by itself; no code change.
//
// Tokens are stored as SHA-256 hashes. A database leak must not yield working
// verification links.

const crypto = require('crypto');
const pool = require('../db');
const { sendMail, isMailerConfigured } = require('../util/mailer');

const TOKEN_TTL_HOURS = 24;

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// True when we can actually deliver a verification email, and therefore when it
// is safe to require one.
function verificationRequired() {
  return isMailerConfigured();
}

// The app's public origin, used to build the link back. The backend has no
// notion of its own address, so: explicit APP_URL, else the first CORS origin
// (index.js already treats that as the canonical public domain), else localhost
// for dev. Trailing slash trimmed so callers can append a path safely.
function appUrl() {
  const explicit = process.env.APP_URL;
  const corsFirst = (process.env.CORS_ORIGIN || '').split(',')[0].trim();
  return (explicit || corsFirst || 'http://localhost:5173').replace(/\/+$/, '');
}

// Issue a fresh token, invalidating any outstanding one for this user AND
// purpose so a resend can't leave two live links. Scoped by purpose so a pending
// password reset doesn't silently kill a pending email verification.
// Runs on the caller's client so it can join the signup transaction.
async function issueToken(client, userId, purpose = 'verify') {
  await client.query(
    `UPDATE coexistence.email_verification_tokens
        SET consumed_at = NOW()
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [userId, purpose]
  );
  const raw = crypto.randomBytes(32).toString('base64url');
  await client.query(
    `INSERT INTO coexistence.email_verification_tokens (user_id, token_hash, expires_at, purpose)
     VALUES ($1, $2, NOW() + INTERVAL '${RESET_TTL_HOURS(purpose)} hours', $3)`,
    [userId, hashToken(raw), purpose]
  );
  return raw;
}

// A reset link is a live credential — a shorter window than an activation link.
function RESET_TTL_HOURS(purpose) {
  return purpose === 'reset' ? 1 : TOKEN_TTL_HOURS;
}

// Best-effort delivery: a mail failure must not roll back a created account.
// Returns the mailer result so callers can surface "we couldn't send it".
async function sendVerificationEmail({ to, token, brandName = 'Zen Chat' }) {
  const link = `${appUrl()}/?verify=${encodeURIComponent(token)}`;
  const text =
    `Welcome to ${brandName}!\n\n` +
    `Confirm your email address to activate your workspace:\n\n${link}\n\n` +
    `This link expires in ${TOKEN_TTL_HOURS} hours. ` +
    `If you didn't create this account, you can ignore this email.`;
  return sendMail({ to, subject: `Confirm your ${brandName} account`, text });
}

// Send a password-reset link. Best-effort, same as verification.
async function sendResetEmail({ to, token, brandName = 'Zen Chat' }) {
  const link = `${appUrl()}/?reset=${encodeURIComponent(token)}`;
  const text =
    `Someone asked to reset the password for your ${brandName} account.\n\n` +
    `Set a new password here:\n\n${link}\n\n` +
    `This link expires in 1 hour and can only be used once.\n\n` +
    `If this wasn't you, ignore this email — your password hasn't changed.`;
  return sendMail({ to, subject: `Reset your ${brandName} password`, text });
}

// Consume a token and mark the user verified. Returns { ok, userId } or
// { ok:false, reason }. Single-use: the UPDATE ... WHERE consumed_at IS NULL
// makes a double-click of the emailed link a no-op rather than an error path.
//
// `purpose` is part of the match: a verification token must never be usable to
// reset a password, or an old activation link becomes a permanent account
// takeover.
async function consumeToken(raw, purpose = 'verify') {
  if (!raw) return { ok: false, reason: 'missing' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE coexistence.email_verification_tokens
          SET consumed_at = NOW()
        WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > NOW()
        RETURNING user_id`,
      [hashToken(raw), purpose]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'invalid_or_expired' };
    }
    const userId = rows[0].user_id;
    await client.query(
      `UPDATE coexistence.z_chat_users
          SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW()
        WHERE id = $1`,
      [userId]
    );
    await client.query('COMMIT');
    return { ok: true, userId };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[verify] consume failed:', err.message);
    return { ok: false, reason: 'error' };
  } finally {
    client.release();
  }
}

module.exports = {
  verificationRequired, issueToken, sendVerificationEmail, sendResetEmail,
  consumeToken, appUrl, hashToken,
};
