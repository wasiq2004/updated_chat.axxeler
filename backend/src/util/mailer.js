// Outbound email via SMTP (nodemailer). Powers the "Send Email" automation
// action and the Human Handoff email notification. Entirely opt-in: without
// SMTP_HOST configured, isMailerConfigured() is false and callers log an honest
// "not configured" instead of failing the flow.
//
// .env:
//   SMTP_HOST=smtp.example.com
//   SMTP_PORT=587            (465 → implicit TLS)
//   SMTP_USER=...            (optional)
//   SMTP_PASS=...            (optional)
//   SMTP_FROM="Zen Chat <no-reply@example.com>"   (defaults to SMTP_USER)

const nodemailer = require('nodemailer');

let transport = null;

function isMailerConfigured() {
  return !!process.env.SMTP_HOST;
}

function getTransport() {
  if (!isMailerConfigured()) return null;
  if (!transport) {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
        : undefined,
    });
  }
  return transport;
}

// Send a plain-text email. Returns { ok, error?, messageId? } — never throws,
// so a mail hiccup can't fail an automation run.
async function sendMail({ to, subject, text }) {
  const t = getTransport();
  if (!t) return { ok: false, error: 'SMTP not configured (set SMTP_HOST in .env)' };
  try {
    const info = await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: String(subject || '').slice(0, 200),
      text: String(text || ''),
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error('[mailer] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendMail, isMailerConfigured };
