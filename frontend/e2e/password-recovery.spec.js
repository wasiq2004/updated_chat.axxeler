// Forgot-password / reset flow. This is the path that makes self-serve signup
// survivable — a workspace of one who forgets their password used to have no
// way back in at all.
import { test, expect } from '@playwright/test';

async function mockPublic(page, { mailer = true } = {}) {
  await page.route('**/api/auth/status', r => r.fulfill({ json: { setupRequired: false } }));
  await page.route('**/api/auth/me', r => r.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/public-config', r => r.fulfill({
    json: { facebook: { enabled: false }, emailVerification: mailer },
  }));
}

test('"Forgot password?" is offered on the sign-in form', async ({ page }) => {
  await mockPublic(page);
  await page.goto('/#/login');
  await expect(page.getByRole('button', { name: 'Forgot password?' })).toBeVisible();
});

test('forgot-password posts the email and confirms without leaking whether it exists', async ({ page }) => {
  await mockPublic(page);
  let body = null;
  await page.route('**/api/auth/forgot-password', async r => {
    body = r.request().postDataJSON();
    await r.fulfill({ json: { ok: true, message: 'If an account exists for that address, we\'ve sent a link to reset its password.' } });
  });
  await page.goto('/#/login');
  await page.getByPlaceholder('admin@example.com').fill('someone@acme.com');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByText(/If an account exists/)).toBeVisible();
  expect(body).toEqual({ email: 'someone@acme.com' });
});

test('forgot-password without an email tells you what to do instead of posting', async ({ page }) => {
  await mockPublic(page);
  let called = false;
  await page.route('**/api/auth/forgot-password', r => { called = true; r.fulfill({ json: { ok: true } }); });
  await page.goto('/#/login');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('alert')).toContainText(/Enter your email/i);
  expect(called).toBe(false);
});

test('a server with no mailer says so rather than promising an email', async ({ page }) => {
  await mockPublic(page, { mailer: false });
  await page.route('**/api/auth/forgot-password', r => r.fulfill({
    json: { ok: false, code: 'NO_MAILER', message: 'Password reset by email isn\'t available on this server. Please contact your administrator to have your password reset.' },
  }));
  await page.goto('/#/login');
  await page.getByPlaceholder('admin@example.com').fill('someone@acme.com');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  // The user must not be left waiting for mail that will never arrive.
  await expect(page.getByText(/isn.t available on this server/i)).toBeVisible();
});

test('the reset link opens the set-a-new-password screen', async ({ page }) => {
  await mockPublic(page);
  await page.goto('/?reset=tok_123');
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
});

test('reset rejects mismatched passwords before hitting the network', async ({ page }) => {
  await mockPublic(page);
  let called = false;
  await page.route('**/api/auth/reset-password', r => { called = true; r.fulfill({ json: {} }); });
  await page.goto('/?reset=tok_123');
  const pw = page.getByPlaceholder('••••••••');
  await pw.first().fill('supersecret1');
  await pw.nth(1).fill('supersecret2');
  await page.getByRole('button', { name: 'Set password & sign in' }).click();
  await expect(page.getByRole('alert')).toContainText(/don.t match/i);
  // The token is single-use: a typo that reached the server would burn it and
  // lock them out for good.
  expect(called).toBe(false);
});

test('reset rejects a short password before hitting the network', async ({ page }) => {
  await mockPublic(page);
  let called = false;
  await page.route('**/api/auth/reset-password', r => { called = true; r.fulfill({ json: {} }); });
  await page.goto('/?reset=tok_123');
  const pw = page.getByPlaceholder('••••••••');
  await pw.first().fill('short');
  await pw.nth(1).fill('short');
  await page.getByRole('button', { name: 'Set password & sign in' }).click();
  await expect(page.getByRole('alert')).toContainText(/at least 8/i);
  expect(called).toBe(false);
});

test('a successful reset signs in and strips the token from the URL', async ({ page }) => {
  await page.route('**/api/**', r => r.fulfill({ json: [] }));
  await page.route('**/api/billing/entitlements', r => r.fulfill({
    json: { features: [], limits: {}, catalog: { plans: [], features: [] }, subscription: { locked: false } },
  }));
  await mockPublic(page);
  let sent = null;
  await page.route('**/api/auth/reset-password', async r => {
    sent = r.request().postDataJSON();
    await r.fulfill({
      json: { user: { id: 5, username: 'p', email: 'p@a.com', displayName: 'P', role: 'admin', tenantId: 2, pages: ['home'], isSuperAdmin: false, isResellerAdmin: false, assignedWaNumbers: [] } },
    });
  });
  await page.goto('/?reset=tok_abc');
  const pw = page.getByPlaceholder('••••••••');
  await pw.first().fill('brandnewpass1');
  await pw.nth(1).fill('brandnewpass1');
  await page.getByRole('button', { name: 'Set password & sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toHaveCount(0, { timeout: 8000 });
  expect(sent).toEqual({ token: 'tok_abc', password: 'brandnewpass1' });
  await expect.poll(() => new URL(page.url()).searchParams.get('reset')).toBeNull();
});

test('an expired reset link routes to sign in rather than dead-ending', async ({ page }) => {
  await mockPublic(page);
  await page.route('**/api/auth/reset-password', r => r.fulfill({
    status: 400, json: { error: 'This reset link is invalid or has expired. Request a new one.', code: 'RESET_INVALID' },
  }));
  await page.goto('/?reset=expired');
  const pw = page.getByPlaceholder('••••••••');
  await pw.first().fill('brandnewpass1');
  await pw.nth(1).fill('brandnewpass1');
  await page.getByRole('button', { name: 'Set password & sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});
