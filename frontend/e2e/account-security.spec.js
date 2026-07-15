// Account & security: set/change your own password, connect/disconnect Facebook.
//
// These two flows previously had no UI at all — the routes existed and nothing
// called them, so a Facebook signup could never obtain a password and a password
// signup could never use Facebook sign-in.
import { test, expect } from '@playwright/test';

function sessionUser(over = {}) {
  return {
    id: 9, username: 'priya', email: 'priya@acme.com', displayName: 'Priya', role: 'admin',
    tenantId: 3, resellerId: null, isSuperAdmin: false, isResellerAdmin: false,
    pages: ['home'], assignedWaNumbers: [], permissions: null, isActive: true,
    passwordSet: true, facebookLinked: false, signupSource: 'self_serve',
    ...over,
  };
}

async function mockApp(page, { user = sessionUser(), fb = false } = {}) {
  await page.route('**/api/**', r => r.fulfill({ json: [] }));
  // HomePage does `data.kpis.map(...)` unguarded, and the app has no error
  // boundary — so a dashboard response of the wrong shape blanks the ENTIRE UI,
  // Topbar included, and every locator below would time out for the wrong reason.
  await page.route('**/api/dashboard**', r => r.fulfill({
    json: { kpis: [], alerts: [], funnel: { stages: [] }, tagDistribution: [] },
  }));
  await page.route('**/api/auth/status', r => r.fulfill({ json: { setupRequired: false } }));
  await page.route('**/api/auth/me', r => r.fulfill({ json: { user } }));
  await page.route('**/api/public-config', r => r.fulfill({
    json: { facebook: { enabled: fb, appId: '1', configId: '2' }, emailVerification: false },
  }));
  await page.route('**/api/billing/entitlements', r => r.fulfill({
    json: { features: [], limits: {}, catalog: { plans: [], features: [] }, subscription: { locked: false }, branding: null },
  }));
  await page.route('**/api/whatsapp-accounts', r => r.fulfill({ json: [{ id: 1 }] })); // suppress the connect popup
}

async function openAccount(page) {
  await page.goto('/');
  // The avatar button is the only control with the user's initial.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: /Account & security/ }).click();
  await expect(page.getByRole('dialog', { name: 'Account and security' })).toBeVisible();
}

test('Account & security is reachable from the avatar menu', async ({ page }) => {
  await mockApp(page);
  await openAccount(page);
  await expect(page.getByRole('heading', { name: 'Change your password' })).toHaveCount(0);
  await expect(page.getByText('Change your password')).toBeVisible();
});

test('a user WITH a password is asked for their current one', async ({ page }) => {
  await mockApp(page);
  await openAccount(page);
  await expect(page.getByText('Current password')).toBeVisible();
});

test('a Facebook user with NO password is warned and not asked for a current one', async ({ page }) => {
  await mockApp(page, { user: sessionUser({ passwordSet: false, signupSource: 'facebook', facebookLinked: true }) });
  await openAccount(page);
  // Asking for a current password would be impossible — the stored hash is
  // random bytes nobody has ever seen.
  await expect(page.getByText('Current password')).toHaveCount(0);
  await expect(page.getByText('Set a password')).toBeVisible();
  await expect(page.getByText(/lose access to your workspace/i)).toBeVisible();
});

test('setting a password posts without a current password when none is set', async ({ page }) => {
  await mockApp(page, { user: sessionUser({ passwordSet: false, signupSource: 'facebook' }) });
  let body = null;
  await page.route('**/api/auth/set-password', async r => {
    body = r.request().postDataJSON();
    await r.fulfill({ json: { ok: true } });
  });
  await openAccount(page);
  const pw = page.getByPlaceholder('••••••••');
  await pw.first().fill('brandnewpass1');
  await pw.nth(1).fill('brandnewpass1');
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText('Password updated.')).toBeVisible();
  expect(body.newPassword).toBe('brandnewpass1');
  expect(body.currentPassword).toBeUndefined();
});

test('changing a password sends the current one', async ({ page }) => {
  await mockApp(page);
  let body = null;
  await page.route('**/api/auth/set-password', async r => {
    body = r.request().postDataJSON();
    await r.fulfill({ json: { ok: true } });
  });
  await openAccount(page);
  await page.getByPlaceholder('••••••••').first().fill('oldpass123');
  const pw = page.getByPlaceholder('••••••••');
  await pw.nth(1).fill('brandnewpass1');
  await pw.nth(2).fill('brandnewpass1');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByText('Password updated.')).toBeVisible();
  expect(body).toMatchObject({ currentPassword: 'oldpass123', newPassword: 'brandnewpass1' });
});

test('mismatched passwords are caught before the network', async ({ page }) => {
  await mockApp(page, { user: sessionUser({ passwordSet: false }) });
  let called = false;
  await page.route('**/api/auth/set-password', r => { called = true; r.fulfill({ json: { ok: true } }); });
  await openAccount(page);
  const pw = page.getByPlaceholder('••••••••');
  await pw.first().fill('brandnewpass1');
  await pw.nth(1).fill('different1234');
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByRole('alert')).toContainText(/don.t match/i);
  expect(called).toBe(false);
});

test('the Facebook section is hidden when Facebook is not configured', async ({ page }) => {
  await mockApp(page, { fb: false });
  await openAccount(page);
  await expect(page.getByText('Facebook sign-in')).toHaveCount(0);
});

test('an unlinked user is offered Connect Facebook', async ({ page }) => {
  await mockApp(page, { fb: true });
  await openAccount(page);
  await expect(page.getByText('Facebook sign-in')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Facebook' })).toBeVisible();
});

test('a linked user sees Connected and can disconnect', async ({ page }) => {
  await mockApp(page, { fb: true, user: sessionUser({ facebookLinked: true }) });
  let unlinked = false;
  await page.route('**/api/auth/unlink-facebook', r => { unlinked = true; r.fulfill({ json: { ok: true } }); });
  await openAccount(page);
  // exact: the blurb above also contains the word "connected".
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect.poll(() => unlinked).toBe(true);
});

test('the server refusing to unlink a passwordless account is surfaced', async ({ page }) => {
  await mockApp(page, { fb: true, user: sessionUser({ passwordSet: false, facebookLinked: true }) });
  await page.route('**/api/auth/unlink-facebook', r => r.fulfill({
    status: 409,
    json: { error: 'Set a password first — Facebook is currently the only way you can sign in.', code: 'NEEDS_PASSWORD' },
  }));
  await openAccount(page);
  await page.getByRole('button', { name: 'Disconnect' }).click();
  // Removing their only way in must be refused, and they must be told why.
  await expect(page.getByRole('alert')).toContainText(/Set a password first/);
});

test('the avatar menu flags an account with no password', async ({ page }) => {
  await mockApp(page, { user: sessionUser({ passwordSet: false, signupSource: 'facebook' }) });
  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();
  // Nothing else in the UI would ever tell them they're one lost Facebook
  // account away from losing the workspace.
  await expect(page.getByLabel('Action needed')).toBeVisible();
});

test('no flag when the account already has a password', async ({ page }) => {
  await mockApp(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByLabel('Action needed')).toHaveCount(0);
});
