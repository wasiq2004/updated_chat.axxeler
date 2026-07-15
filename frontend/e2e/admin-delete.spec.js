// Delete button in the Super Admin → Admins list.
// The row is clickable (it opens the drill-down), so the highest-value thing to
// prove here is that delete does NOT also trigger that.
import { test, expect } from '@playwright/test';

const SUPER = {
  id: 1, username: 'owner', email: 'owner@zen.io', displayName: 'Owner', role: 'admin',
  tenantId: null, resellerId: null, isSuperAdmin: true, isResellerAdmin: false,
  pages: ['home', 'super-admin'], assignedWaNumbers: [], permissions: null, isActive: true,
};

const TENANTS = [
  { id: 7, name: 'Northwind Trading Co.', slug: 'northwind', status: 'active', plan_name: 'Growth', organizations: 2, users: 5, signup_source: 'self_serve', pending_plan_requests: 0 },
  { id: 8, name: 'Solo Shop', slug: 'solo-shop', status: 'active', plan_name: 'Starter', organizations: 1, users: 1, signup_source: 'invite', pending_plan_requests: 0 },
];

async function mockConsole(page) {
  // Catch-all first — Playwright matches routes last-registered-first.
  await page.route('**/api/**', r => r.fulfill({ json: [] }));
  await page.route('**/api/auth/status', r => r.fulfill({ json: { setupRequired: false } }));
  await page.route('**/api/auth/me', r => r.fulfill({ json: { user: SUPER } }));
  await page.route('**/api/public-config', r => r.fulfill({ json: { facebook: { enabled: false }, emailVerification: false } }));
  await page.route('**/api/billing/entitlements', r => r.fulfill({
    json: { isSuperAdmin: true, features: [], limits: {}, catalog: { plans: [], features: [] }, subscription: { locked: false }, branding: null },
  }));
  await page.route('**/api/platform/plans', r => r.fulfill({ json: [] }));
  await page.route('**/api/platform/tenants', r => r.fulfill({ json: TENANTS }));
}

async function gotoAdmins(page) {
  await page.goto('/#/super-admin');
  await page.getByRole('button', { name: 'Admins' }).click();
  await expect(page.getByText('Northwind Trading Co.')).toBeVisible();
}

test('every admin row has a delete button', async ({ page }) => {
  await mockConsole(page);
  await gotoAdmins(page);
  await expect(page.getByRole('button', { name: 'Delete Northwind Trading Co.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete Solo Shop' })).toBeVisible();
});

test('clicking delete opens the dialog and does NOT open the drill-down', async ({ page }) => {
  await mockConsole(page);
  await gotoAdmins(page);
  await page.getByRole('button', { name: 'Delete Northwind Trading Co.' }).click();
  await expect(page.getByText('Delete “Northwind Trading Co.”?')).toBeVisible();
  // The row's own onClick must not have fired: the drill-down loads users.
  await expect(page.getByText('Organizations & users')).toHaveCount(0);
});

test('delete is blocked until the name is typed exactly', async ({ page }) => {
  await mockConsole(page);
  let called = false;
  await page.route('**/api/platform/tenants/7', r => { called = true; r.fulfill({ json: { ok: true } }); });
  await gotoAdmins(page);
  await page.getByRole('button', { name: 'Delete Northwind Trading Co.' }).click();

  const confirmBtn = page.getByRole('button', { name: 'Delete admin' });
  await expect(confirmBtn).toBeDisabled();
  await page.getByPlaceholder('Northwind Trading Co.').fill('Northwind');   // partial
  await expect(confirmBtn).toBeDisabled();
  await page.getByPlaceholder('Northwind Trading Co.').fill('Northwind Trading Co.');
  await expect(confirmBtn).toBeEnabled();
  expect(called).toBe(false);
});

test('confirming sends DELETE to the right tenant and closes the dialog', async ({ page }) => {
  await mockConsole(page);
  let method = null;
  let url = null;
  await page.route('**/api/platform/tenants/7', async r => {
    method = r.request().method();
    url = r.request().url();
    await r.fulfill({ json: { ok: true, disabledLogins: 5 } });
  });
  await gotoAdmins(page);
  await page.getByRole('button', { name: 'Delete Northwind Trading Co.' }).click();
  await page.getByPlaceholder('Northwind Trading Co.').fill('Northwind Trading Co.');
  await page.getByRole('button', { name: 'Delete admin' }).click();

  await expect(page.getByText('Delete “Northwind Trading Co.”?')).toHaveCount(0);
  expect(method).toBe('DELETE');
  expect(url).toContain('/api/platform/tenants/7');
});

test('the dialog warns when more than one person is locked out', async ({ page }) => {
  await mockConsole(page);
  await gotoAdmins(page);
  // 5 users -> warning.
  await page.getByRole('button', { name: 'Delete Northwind Trading Co.' }).click();
  await expect(page.getByText(/locks out/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  // 1 user -> no warning.
  await page.getByRole('button', { name: 'Delete Solo Shop' }).click();
  await expect(page.getByText(/locks out/)).toHaveCount(0);
});

test('the dialog states that data is kept, not destroyed', async ({ page }) => {
  await mockConsole(page);
  await gotoAdmins(page);
  await page.getByRole('button', { name: 'Delete Solo Shop' }).click();
  await expect(page.getByText(/Conversations, contacts and connected WhatsApp numbers are/)).toBeVisible();
});

test('a server error is surfaced, not swallowed', async ({ page }) => {
  await mockConsole(page);
  await page.route('**/api/platform/tenants/7', r => r.fulfill({ status: 500, json: { error: 'Failed to delete admin' } }));
  await gotoAdmins(page);
  await page.getByRole('button', { name: 'Delete Northwind Trading Co.' }).click();
  await page.getByPlaceholder('Northwind Trading Co.').fill('Northwind Trading Co.');
  await page.getByRole('button', { name: 'Delete admin' }).click();
  await expect(page.getByText('Failed to delete admin')).toBeVisible();
  // Dialog stays open so the operator can retry.
  await expect(page.getByText('Delete “Northwind Trading Co.”?')).toBeVisible();
});
