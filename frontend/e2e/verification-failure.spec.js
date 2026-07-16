// What happens when SMTP is configured but BROKEN.
//
// This is the trap this work exists to close: signup created the account, the
// mailer rejected the email, and the person was told "check your inbox" for mail
// that would never arrive — with a Resend button that failed identically. The
// only trace was a server log line nobody reads.
import { test, expect } from '@playwright/test';

const SUPER = {
  id: 1, username: 'owner', email: 'owner@zen.io', displayName: 'Owner', role: 'admin',
  tenantId: null, resellerId: null, isSuperAdmin: true, isResellerAdmin: false,
  pages: ['home', 'super-admin'], assignedWaNumbers: [], permissions: null, isActive: true,
  passwordSet: true, facebookLinked: false, signupSource: 'invite',
};

const SMTP_ERROR = 'Invalid login: 535 Authentication credentials invalid';

async function mockPublic(page) {
  await page.route('**/api/auth/status', r => r.fulfill({ json: { setupRequired: false } }));
  await page.route('**/api/auth/me', r => r.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/public-config', r => r.fulfill({
    json: { facebook: { enabled: false }, emailVerification: true },
  }));
}

test('a rejected email tells the truth instead of "check your inbox"', async ({ page }) => {
  await mockPublic(page);
  await page.route('**/api/auth/signup', r => r.fulfill({
    status: 201, json: { verificationRequired: true, email: 'stuck@acme.com', emailSent: false },
  }));
  await page.goto('/#/signup');
  await page.getByPlaceholder('you@company.com').fill('stuck@acme.com');
  await page.getByPlaceholder('••••••••').fill('supersecret1');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: /Your account is ready/ })).toBeVisible();
  await expect(page.getByText(/problem on our side, not yours/)).toBeVisible();
  // Never claim mail is coming when the server already told us it was rejected.
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toHaveCount(0);
});

test('no Resend button when resending would repeat the same failure', async ({ page }) => {
  await mockPublic(page);
  let resendCalled = false;
  await page.route('**/api/auth/resend-verification', r => { resendCalled = true; r.fulfill({ json: { ok: true } }); });
  await page.route('**/api/auth/signup', r => r.fulfill({
    status: 201, json: { verificationRequired: true, email: 'stuck@acme.com', emailSent: false },
  }));
  await page.goto('/#/signup');
  await page.getByPlaceholder('you@company.com').fill('stuck@acme.com');
  await page.getByPlaceholder('••••••••').fill('supersecret1');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Resend the link' })).toHaveCount(0);
  expect(resendCalled).toBe(false);
});

test('a SUCCESSFUL send still shows the normal inbox screen with Resend', async ({ page }) => {
  await mockPublic(page);
  await page.route('**/api/auth/signup', r => r.fulfill({
    status: 201, json: { verificationRequired: true, email: 'ok@acme.com', emailSent: true },
  }));
  await page.goto('/#/signup');
  await page.getByPlaceholder('you@company.com').fill('ok@acme.com');
  await page.getByPlaceholder('••••••••').fill('supersecret1');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resend the link' })).toBeVisible();
});

// ── Operator side ───────────────────────────────────────────────────────────

async function mockConsole(page, signups) {
  await page.route('**/api/**', r => r.fulfill({ json: [] }));
  await page.route('**/api/auth/status', r => r.fulfill({ json: { setupRequired: false } }));
  await page.route('**/api/auth/me', r => r.fulfill({ json: { user: SUPER } }));
  await page.route('**/api/public-config', r => r.fulfill({ json: { facebook: { enabled: false }, emailVerification: true } }));
  await page.route('**/api/billing/entitlements', r => r.fulfill({
    json: { isSuperAdmin: true, features: [], limits: {}, catalog: { plans: [], features: [] }, subscription: { locked: false }, branding: null },
  }));
  await page.route('**/api/platform/signups', r => r.fulfill({ json: signups }));
}

const STUCK = {
  id: 42, email: 'stuck@acme.com', name: 'Stuck Person', createdAt: '2026-07-16T10:00:00Z',
  sentAt: '2026-07-16T10:00:01Z', error: SMTP_ERROR, tenant: { id: 7, name: 'Acme' },
};
const IGNORED = {
  id: 43, email: 'lazy@acme.com', name: 'Lazy Person', createdAt: '2026-07-15T10:00:00Z',
  sentAt: '2026-07-15T10:00:01Z', error: null, tenant: { id: 8, name: 'Beta' },
};

test('the console rail flags stranded signups', async ({ page }) => {
  await mockConsole(page, [STUCK, IGNORED]);
  await page.goto('/#/super-admin');
  // Nobody would think to go looking — the count is the whole point.
  await expect(page.getByRole('button', { name: /Unverified/ })).toBeVisible();
  await expect(page.getByLabel('2 pending')).toBeVisible();
});

test('the section is hidden entirely when nobody is stuck', async ({ page }) => {
  await mockConsole(page, []);
  await page.goto('/#/super-admin');
  // On a healthy install this would just be permanent noise.
  await expect(page.getByRole('button', { name: /Unverified/ })).toHaveCount(0);
});

test('a delivery failure is shown as OUR problem, with the provider’s reason', async ({ page }) => {
  await mockConsole(page, [STUCK, IGNORED]);
  await page.goto('/#/super-admin');
  await page.getByRole('button', { name: /Unverified/ }).click();
  await expect(page.getByText('Confirmation emails are failing to send')).toBeVisible();
  await expect(page.getByText(SMTP_ERROR)).toBeVisible();
  // "we failed to deliver" and "they ignored it" are different problems.
  await expect(page.getByText('Delivery failed')).toBeVisible();
  await expect(page.getByText('Sent, not confirmed')).toBeVisible();
});

test('no alarm banner when the mailer is healthy and people just haven’t clicked', async ({ page }) => {
  await mockConsole(page, [IGNORED]);
  await page.goto('/#/super-admin');
  await page.getByRole('button', { name: /Unverified/ }).click();
  await expect(page.getByText('Confirmation emails are failing to send')).toHaveCount(0);
  await expect(page.getByText('Sent, not confirmed')).toBeVisible();
});

test('verifying by hand posts to the right user and refreshes', async ({ page }) => {
  await mockConsole(page, [STUCK]);
  let posted = null;
  await page.route('**/api/platform/users/*/verify-email', async r => {
    posted = r.request().url();
    await r.fulfill({ json: { ok: true } });
  });
  await page.goto('/#/super-admin');
  await page.getByRole('button', { name: /Unverified/ }).click();
  await page.getByRole('button', { name: 'Verify manually' }).click();
  await expect.poll(() => posted).toContain('/api/platform/users/42/verify-email');
});

test('a failed manual verify surfaces instead of silently doing nothing', async ({ page }) => {
  await mockConsole(page, [STUCK]);
  await page.route('**/api/platform/users/*/verify-email', r => r.fulfill({
    status: 404, json: { error: 'No unverified signup with that id' },
  }));
  await page.goto('/#/super-admin');
  await page.getByRole('button', { name: /Unverified/ }).click();
  await page.getByRole('button', { name: 'Verify manually' }).click();
  await expect(page.getByText('No unverified signup with that id')).toBeVisible();
});
