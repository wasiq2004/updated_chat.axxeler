// Send one real email to prove the SMTP credentials work.
//
//   node backend/scripts/test-smtp.js you@example.com
//
// Why this exists: util/mailer.sendMail never throws — it swallows failures into
// a console line and returns { ok: false }. So a wrong password or an
// unverified From: address shows up in production as a signup that silently
// never arrives. This script surfaces the provider's actual error instead.
//
// Reads the REPO-ROOT .env (what docker compose uses), not backend/.env.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { sendMail, isMailerConfigured } = require('../src/util/mailer');

const to = process.argv[2];

function fail(msg) {
  console.error(`\n  ✖ ${msg}\n`);
  process.exit(1);
}

(async () => {
  if (!to) fail('Usage: node backend/scripts/test-smtp.js <recipient@example.com>');

  console.log('\n  SMTP configuration (from the repo-root .env)');
  console.log(`    SMTP_HOST : ${process.env.SMTP_HOST || '(unset)'}`);
  console.log(`    SMTP_PORT : ${process.env.SMTP_PORT || '(unset — defaults to 587)'}`);
  console.log(`    SMTP_USER : ${process.env.SMTP_USER || '(unset — will connect unauthenticated)'}`);
  // Never print the password. Length alone is enough to spot an empty or
  // truncated paste, which is the usual mistake.
  console.log(`    SMTP_PASS : ${process.env.SMTP_PASS ? `set (${process.env.SMTP_PASS.length} chars)` : '(unset)'}`);
  console.log(`    SMTP_FROM : ${process.env.SMTP_FROM || '(unset — falls back to SMTP_USER)'}`);
  console.log(`    APP_URL   : ${process.env.APP_URL || '(unset — verification links fall back to CORS_ORIGIN)'}`);

  if (!isMailerConfigured()) {
    fail('SMTP_HOST is not set, so the app treats the mailer as absent.\n' +
         '    Signups will auto-verify instead of sending a link. Set SMTP_HOST to turn verification on.');
  }

  // Mirrors what a real verification email looks like, so a provider that
  // rejects the From: address or the link fails here rather than at signup.
  const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
  console.log(`\n  Sending to ${to} …`);
  const result = await sendMail({
    to,
    subject: 'Zen Chat SMTP test',
    text:
      'This is a test from the Zen Chat SMTP check.\n\n' +
      'If you can read this, signup confirmation emails will work.\n\n' +
      `A real confirmation link would look like:\n${appUrl}/?verify=example-token\n`,
  });

  if (!result.ok) {
    fail(`Send FAILED: ${result.error}\n\n` +
         '    Common causes:\n' +
         '      • Wrong SMTP_PASS (for Resend this is the API key, starting "re_")\n' +
         '      • SMTP_FROM uses a domain the provider has not verified yet\n' +
         '      • Port blocked by the host — try 587, or 465 for implicit TLS\n' +
         '      • Provider still in test mode: can only send to your own account address');
  }

  console.log(`\n  ✔ Sent. messageId: ${result.messageId}`);
  console.log('    Check the inbox — and the spam folder. Landing in spam means');
  console.log('    SPF/DKIM DNS records are missing or not yet propagated.\n');
  process.exit(0);
})().catch(err => fail(`Unexpected error: ${err.message}`));
