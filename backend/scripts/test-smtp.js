// Send one real email to prove the mail configuration works.
//
//   node backend/scripts/test-smtp.js you@example.com
//
// Why this exists: util/mailer.sendMail never throws — it swallows failures into
// a console line and returns { ok: false }. So a wrong key, an unverified sender
// domain, or a host that blocks outbound SMTP all look identical in production:
// a signup that silently never arrives. This surfaces the provider's real error.
//
// Reads the REPO-ROOT .env (what docker compose uses), not backend/.env.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { sendMail, isMailerConfigured, mailerMode } = require('../src/util/mailer');

const to = process.argv[2];

function fail(msg) {
  console.error(`\n  ✖ ${msg}\n`);
  process.exit(1);
}

(async () => {
  if (!to) fail('Usage: node backend/scripts/test-smtp.js <recipient@example.com>');

  const mode = mailerMode();
  console.log(`\n  Transport: ${mode}`);

  if (mode === 'resend-http') {
    const key = process.env.RESEND_API_KEY || '';
    console.log(`    RESEND_API_KEY : set (${key.length} chars, starts '${key.slice(0, 3)}')`);
    console.log(`    MAIL_FROM      : ${process.env.MAIL_FROM || process.env.SMTP_FROM || '(unset)'}`);
  } else if (mode === 'smtp') {
    console.log(`    SMTP_HOST : ${process.env.SMTP_HOST}`);
    console.log(`    SMTP_PORT : ${process.env.SMTP_PORT || '(unset — defaults to 587)'}`);
    console.log(`    SMTP_USER : ${process.env.SMTP_USER || '(unset — unauthenticated)'}`);
    // Never print the password. Length alone spots an empty or truncated paste.
    console.log(`    SMTP_PASS : ${process.env.SMTP_PASS ? `set (${process.env.SMTP_PASS.length} chars)` : '(unset)'}`);
    console.log(`    SMTP_FROM : ${process.env.SMTP_FROM || '(unset — falls back to SMTP_USER)'}`);
    console.log('\n    NOTE: many cloud hosts block outbound SMTP. If this fails with');
    console.log('    "Greeting never received", the port is blocked — no credential change');
    console.log('    will fix it. Set RESEND_API_KEY instead and drop SMTP_HOST.');
  }
  console.log(`    APP_URL   : ${process.env.APP_URL || '(unset — links fall back to CORS_ORIGIN)'}`);

  if (!isMailerConfigured()) {
    fail('No mail transport configured, so the app treats email as absent.\n' +
         '    Signups auto-verify instead of sending a link.\n' +
         '    Set RESEND_API_KEY (recommended) or SMTP_HOST to turn verification on.');
  }

  const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
  console.log(`\n  Sending to ${to} …`);
  const result = await sendMail({
    to,
    subject: 'Zen Chat mail test',
    text:
      'This is a test from the Zen Chat mail check.\n\n' +
      'If you can read this, signup confirmation emails will work.\n\n' +
      `A real confirmation link would look like:\n${appUrl}/?verify=example-token\n`,
  });

  if (!result.ok) {
    fail(`Send FAILED: ${result.error}\n\n` +
         '    Common causes:\n' +
         '      • Sender domain not verified with the provider (check MAIL_FROM)\n' +
         '      • Wrong/revoked API key\n' +
         '      • Provider still in test mode: can only send to your own account address\n' +
         '      • (SMTP only) outbound port blocked by your host');
  }

  console.log(`\n  ✔ Sent. id: ${result.messageId || '(none returned)'}`);
  console.log('    Check the inbox — and the spam folder. Landing in spam means');
  console.log('    SPF/DKIM DNS records are missing or not yet propagated.\n');
  process.exit(0);
})().catch(err => fail(`Unexpected error: ${err.message}`));
