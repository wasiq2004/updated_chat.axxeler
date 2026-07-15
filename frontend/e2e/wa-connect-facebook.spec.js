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

// Stub the Facebook JS SDK. loadFacebookSdk() returns early when window.FB
// already exists, so this replaces the real SDK without touching the network.
//
// The message event must be dispatched with a spoofed `origin` — the modal
// rejects anything not from *.facebook.com, which is exactly right, and means a
// plain postMessage from the page would be ignored.
async function stubFacebookSdk(page, { wabaId = 'WABA_1', phoneNumberId = 'PHONE_1', code = 'CODE_ABC' } = {}) {
  await page.addInitScript(({ wabaId, phoneNumberId, code }) => {
    window.FB = {
      init() {},
      login(cb) {
        window.dispatchEvent(new MessageEvent('message', {
          origin: 'https://www.facebook.com',
          data: JSON.stringify({
            type: 'WA_EMBEDDED_SIGNUP',
            event: 'FINISH',
            data: { waba_id: wabaId, phone_number_id: phoneNumberId },
          }),
        }));
        cb({ authResponse: { code } });
      },
    };
  }, { wabaId, phoneNumberId, code });
}

test('the FIRST number connects via Facebook from the empty state, end to end', async ({ page }) => {
  // Zero accounts — the case that matters here.
  let posted = null;
  let listCalls = 0;
  await mockApp(page, { accounts: [] });
  await stubFacebookSdk(page);
  await page.route('**/api/whatsapp-accounts', async r => {
    if (r.request().method() === 'GET') {
      listCalls++;
      // After a successful connect the refresh must show the new number.
      await r.fulfill({ json: posted ? [ACCOUNT] : [] });
      return;
    }
    await r.fallback();
  });
  await page.route('**/api/whatsapp-accounts/embedded-signup', async r => {
    posted = r.request().postDataJSON();
    await r.fulfill({ status: 201, json: { ...ACCOUNT, registered: true, fbLinked: false } });
  });

  await gotoPanel(page);
  await expect(page.getByText('No WhatsApp Business account connected yet')).toBeVisible();
  await page.getByRole('button', { name: 'Connect with Facebook' }).last().click();
  await page.getByRole('button', { name: 'Login with Facebook' }).click();

  // Success screen — NOT skipped past.
  await expect(page.getByText('WhatsApp connected!')).toBeVisible();
  // The code AND the ids scraped from the message event all reached the server.
  expect(posted).toMatchObject({ code: 'CODE_ABC', wabaId: 'WABA_1', phoneNumberId: 'PHONE_1' });

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Connect WhatsApp via Facebook' })).toHaveCount(0);
  // The list refreshed behind the modal and now shows the connected number.
  await expect(page.getByText('Acme Sales')).toBeVisible();
  expect(listCalls).toBeGreaterThan(1);
});

test('a number Meta refused to register says so instead of claiming success', async ({ page }) => {
  await mockApp(page, { accounts: [] });
  await stubFacebookSdk(page);
  await page.route('**/api/whatsapp-accounts/embedded-signup', r => r.fulfill({
    status: 201,
    json: { ...ACCOUNT, registered: false, registrationCode: 133005, registrationError: 'two-step PIN mismatch' },
  }));
  await gotoPanel(page);
  await page.getByRole('button', { name: 'Connect with Facebook' }).last().click();
  await page.getByRole('button', { name: 'Login with Facebook' }).click();
  // The number saved but cannot send — the success screen must not lie about it.
  await expect(page.getByText('Almost there')).toBeVisible();
  await expect(page.getByText(/two-step PIN we don.t know/)).toBeVisible();
});

test('a cancelled Facebook flow does not post a half-finished signup', async ({ page }) => {
  await mockApp(page, { accounts: [] });
  // CANCEL carrying partial data — the shape that used to be treated as success.
  await page.addInitScript(() => {
    window.FB = {
      init() {},
      login(cb) {
        window.dispatchEvent(new MessageEvent('message', {
          origin: 'https://www.facebook.com',
          data: JSON.stringify({
            type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL',
            data: { waba_id: 'WABA_1', error_message: 'User cancelled' },
          }),
        }));
        cb({ authResponse: { code: 'CODE_ABC' } });
      },
    };
  });
  let posted = false;
  await page.route('**/api/whatsapp-accounts/embedded-signup', r => { posted = true; r.fulfill({ json: {} }); });
  await gotoPanel(page);
  await page.getByRole('button', { name: 'Connect with Facebook' }).last().click();
  await page.getByRole('button', { name: 'Login with Facebook' }).click();
  await expect(page.getByText('User cancelled')).toBeVisible();
  expect(posted).toBe(false);
});

test('the list still marks which accounts came from Facebook', async ({ page }) => {
  await mockApp(page, { accounts: [ACCOUNT, { ...ACCOUNT, id: 2, displayName: 'Manual One', connectionMethod: 'manual' }] });
  await gotoPanel(page);
  await expect(page.getByText('Facebook', { exact: true })).toHaveCount(1);
});
