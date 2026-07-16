// Outbound email. Powers the "Send Email" automation action, the Human Handoff
// notification, signup verification and password resets. Entirely opt-in: with
// nothing configured, isMailerConfigured() is false and callers log an honest
// "not configured" instead of failing the flow.
//
// TWO transports, HTTP preferred:
//
//   1. Resend HTTP API (RESEND_API_KEY) — plain HTTPS on 443.
//   2. SMTP (SMTP_HOST) — nodemailer.
//
// HTTP is the default recommendation because SMTP ports are routinely blocked on
// cloud hosts. A blocked 587 fails as "Greeting never received" — the TCP
// connect is swallowed and no SMTP banner ever arrives — which looks like a
// credentials problem but no key change can fix. Port 443 is never blocked.
//
// .env — HTTP (recommended):
//   RESEND_API_KEY=re_...
//   MAIL_FROM="Zen Chat <no-reply@yourdomain.com>"    (or SMTP_FROM)
//
// .env — SMTP (fallback):
//   SMTP_HOST=smtp.example.com
//   SMTP_PORT=587            (465 → implicit TLS)
//   SMTP_USER=...            (optional)
//   SMTP_PASS=...            (optional)
//   SMTP_FROM="Zen Chat <no-reply@example.com>"   (defaults to SMTP_USER)

const nodemailer = require('nodemailer');

let transport = null;

const RESEND_API_KEY = () => (process.env.RESEND_API_KEY || '').trim();
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// The From address, in either mode. MAIL_FROM is the transport-neutral name;
// SMTP_FROM is honoured so an existing SMTP config keeps working unchanged.
function fromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || '';
}

function useHttp() {
  return !!RESEND_API_KEY();
}

function isMailerConfigured() {
  return useHttp() || !!process.env.SMTP_HOST;
}

// Which transport is live, for diagnostics and the startup log.
function mailerMode() {
  if (useHttp()) return 'resend-http';
  if (process.env.SMTP_HOST) return 'smtp';
  return 'none';
}

function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  if (!transport) {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
        : undefined,
      // Bound the wait. Without these a blocked port hangs the request until the
      // OS gives up (minutes), holding a signup open the whole time.
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
  }
  return transport;
}

async function sendViaResend({ to, subject, text }) {
  const from = fromAddress();
  if (!from) {
    return { ok: false, error: 'No sender address (set MAIL_FROM in .env)' };
  }
  try {
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // Resend's own message is far more useful than a status code: it names the
      // unverified domain, the invalid key, the blocked recipient.
      return { ok: false, error: body?.message || body?.error?.message || `Resend HTTP ${resp.status}` };
    }
    return { ok: true, messageId: body?.id || null };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'Resend API timed out' : err.message };
  }
}

async function sendViaSmtp({ to, subject, text }) {
  const t = getTransport();
  if (!t) return { ok: false, error: 'SMTP not configured (set SMTP_HOST in .env)' };
  try {
    const info = await t.sendMail({
      from: fromAddress(),
      to,
      subject,
      text,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    // "Greeting never received" almost always means the host blocks outbound
    // SMTP, not that anything is misconfigured. Say so — the raw string sends
    // people hunting for a credentials bug that isn't there.
    if (/greeting never received|ETIMEDOUT|ECONNREFUSED|ESOCKET/i.test(err.message || '')) {
      return {
        ok: false,
        error: `${err.message} — the SMTP port is most likely blocked by your host. `
             + `Use the HTTP API instead: set RESEND_API_KEY and drop SMTP_HOST.`,
      };
    }
    return { ok: false, error: err.message };
  }
}

// Send a plain-text email. Returns { ok, error?, messageId? } — never throws, so
// a mail hiccup can't fail an automation run or a signup.
async function sendMail({ to, subject, text }) {
  if (!isMailerConfigured()) {
    return { ok: false, error: 'Email not configured (set RESEND_API_KEY, or SMTP_HOST, in .env)' };
  }
  const payload = {
    to,
    subject: String(subject || '').slice(0, 200),
    text: String(text || ''),
  };
  const result = useHttp() ? await sendViaResend(payload) : await sendViaSmtp(payload);
  if (!result.ok) console.error(`[mailer:${mailerMode()}] send failed:`, result.error);
  return result;
}

module.exports = { sendMail, isMailerConfigured, mailerMode };
