// "Connect with Facebook" in Settings → WhatsApp Accounts.
//
// Before this, Embedded Signup lived ONLY in the post-login nudge, which fires
// once per session and only at zero accounts — so there was no way to reach it
// from the accounts panel, and no way to add a second number without pasting a
// permanent token by hand.
import { test, expect } from '@playwright/test';

const ADMIN = {
  id: 9, username: 'priya', email: 'p@a.com', displayName: 'Priya', role: 'admin',
  tenantId: 3, resellerId: null, isSuperAdmin: false, isResellerAdmin: false,
  pages: ['home', 'admin-settings:whatsapp-accounts', 'admin-settings:general'],
  assignedWaNumbers: [], permissions: null, isActive: true,
  passwordSet: true, facebookLinked: false, signupSource: 'invite',
};

const ACCOUNT = {
  id: 1, displayName: 'Acme Sales', displayPhoneNumber: '919876543210',
  phoneNumberId: '111', wabaId: '222', metaAppId: '333',
  isDefault: true, isActive: true, healthStatus: 'ok', connectionMethod: 'embedded_signup',
};

async function mockApp(page, { fb = true, accounts = [], nudgeSeen = true } = {}) {
  if (nudgeSeen) {
    // At zero accounts the post-login nudge auto-opens over everything (z-index
    // 500) and swallows clicks on the panel beneath. That's correct behaviour —
    // a real user dismisses it once, which sets this flag for the session.
    await page.addInitScript(() => {
      try { sessionStorage.setItem('zc_fb_connect_seen', '1'); } catch { /* ignore */ }
    });
  }
  await page.route('**/api/**', r => r.fulfill({ json: [] }));
  await page.route('**/api/dashboard**', r => r.fulfill({
    json: { kpis: [], alerts: [], funnel: { stages: [] }, tagDistribution: [] },
  }));
  await page.route('**/api/auth/status', r => r.fulfill({ json: { setupRequired: false } }));
  await page.route('**/api/auth/me', r => r.fulfill({ json: { user: ADMIN } }));
  await page.route('**/api/public-config', r => r.fulfill({
    json: { facebook: { enabled: fb, appId: '1', configId: '1517165402986606' }, emailVerification: false },
  }));
  await page.route('**/api/billing/entitlements', r => r.fulfill({
    json: { features: [], limits: {}, catalog: { plans: [], features: [] }, subscription: { locked: false }, branding: null },
  }));
  await page.route('**/api/whatsapp-accounts*', r => r.fulfill({ json: accounts }));
}

async function gotoPanel(page) {
  await page.goto('/#/admin-settings/whatsapp-accounts');
  await expect(page.getByRole('heading', { name: 'WhatsApp Accounts' })).toBeVisible();
}

test('the panel offers Connect with Facebook when Meta is configured', async ({ page }) => {
  await mockApp(page, { accounts: [ACCOUNT] });
  await gotoPanel(page);
  await expect(page.getByRole('button', { name: 'Connect with Facebook' })).toBeVisible();
  // Manual entry stays available, stepped back to a secondary action.
  await expect(page.getByRole('button', { name: 'Add manually' })).toBeVisible();
});

test('with Facebook NOT configured, only manual entry is offered', async ({ page }) => {
  await mockApp(page, { fb: false, accounts: [ACCOUNT] });
  await gotoPanel(page);
  // A button that can only apologise is worse than no button.
  await expect(page.getByRole('button', { name: 'Connect with Facebook' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect account' })).toBeVisible();
});

test('the empty state offers a way out, not just a description', async ({ page }) => {
  await mockApp(page, { accounts: [] });
  await gotoPanel(page);
  await expect(page.getByText('No WhatsApp Business account connected yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect with Facebook' })).toHaveCount(2); // header + empty state
});

test('clicking it opens the Embedded Signup modal with settings-appropriate copy', async ({ page }) => {
  await mockApp(page, { accounts: [] });
  await gotoPanel(page);
  await page.getByRole('button', { name: 'Connect with Facebook' }).first().click();
  await expect(page.getByRole('heading', { name: 'Connect WhatsApp via Facebook' })).toBeVisible();
  // The first-run nudge's copy is nonsense once you're already in Settings.
  await expect(page.getByText(/I.ll do this later/)).toHaveCount(0);
  await expect(page.getByText(/connect manually anytime in Settings/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
});

test('the first-run nudge keeps its own copy', async ({ page }) => {
  // Same component, other context: App auto-opens it after login at zero
  // accounts. nudgeSeen:false lets it fire, which is the whole point here.
  await mockApp(page, { accounts: [], nudgeSeen: false });
  await page.goto('/#/home');
  await expect(page.getByText(/I.ll do this later/)).toBeVisible();
  await expect(page.getByText(/connect manually anytime in Settings/)).toBeVisible();
});

test('Cancel closes the modal and leaves the panel intact', async ({ page }) => {
  await mockApp(page, { accounts: [ACCOUNT] });
  await gotoPanel(page);
  await page.getByRole('button', { name: 'Connect with Facebook' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Connect WhatsApp via Facebook' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'WhatsApp Accounts' })).toBeVisible();
});

test('the list still marks which accounts came from Facebook', async ({ page }) => {
  await mockApp(page, { accounts: [ACCOUNT, { ...ACCOUNT, id: 2, displayName: 'Manual One', connectionMethod: 'manual' }] });
  await gotoPanel(page);
  await expect(page.getByText('Facebook', { exact: true })).toHaveCount(1);
});
