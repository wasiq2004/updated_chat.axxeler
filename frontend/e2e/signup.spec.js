// Drives the real signup UI in a browser against mocked API routes. Static
// checks can't tell you whether the tabs render, whether "Start Free" opens the
// signup form, or whether the partner slug actually reaches the server.
import { test, expect } from '@playwright/test';

const BASE = '';  // baseURL comes from playwright.config.js

// Minimal fixtures for the public endpoints the logged-out app calls.
async function mockPublic(page, { fbEnabled = false } = {}) {
  await page.route('**/api/auth/status', r => r.fulfill({ json: { setupRequired: false } }));
  await page.route('**/api/auth/me', r => r.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/public-config', r => r.fulfill({
    json: { facebook: { enabled: fbEnabled, appId: '1', configId: '2' }, emailVerification: true },
  }));
}

test('landing "Start Free" opens the SIGNUP form, not sign-in', async ({ page }) => {
  await mockPublic(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Start Free' }).first().click();
  // The signup tab must be the selected one.
  await expect(page.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
});

test('landing "Log in" opens the SIGN-IN form', async ({ page }) => {
  await mockPublic(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Log in' }).first().click();
  await expect(page.getByRole('tab', { name: 'Sign in' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('tabs switch between sign-in and signup and are keyboard reachable', async ({ page }) => {
  await mockPublic(page);
  await page.goto(`/#/login`);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByRole('tab', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
  // Company + name fields only exist on signup.
  await expect(page.getByPlaceholder('Acme Pvt Ltd')).toBeVisible();
  await page.getByRole('tab', { name: 'Sign in' }).click();
  await expect(page.getByPlaceholder('Acme Pvt Ltd')).toHaveCount(0);
});

test('signup posts the right body and shows the check-your-inbox screen', async ({ page }) => {
  await mockPublic(page);
  let body = null;
  await page.route('**/api/auth/signup', async r => {
    body = r.request().postDataJSON();
    await r.fulfill({ status: 201, json: { verificationRequired: true, email: body.email, emailSent: true } });
  });
  await page.goto(`/#/signup`);
  await page.getByPlaceholder('Priya Sharma').fill('Priya Sharma');
  await page.getByPlaceholder('Acme Pvt Ltd').fill('Acme Pvt Ltd');
  await page.getByPlaceholder('you@company.com').fill('priya@acme.com');
  await page.getByPlaceholder('••••••••').fill('supersecret1');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await expect(page.getByText('priya@acme.com')).toBeVisible();
  expect(body).toMatchObject({
    email: 'priya@acme.com',
    password: 'supersecret1',
    displayName: 'Priya Sharma',
    companyName: 'Acme Pvt Ltd',
    partnerSlug: null,
    acceptedTerms: true,
  });
});

test('signup is refused until the terms are accepted', async ({ page }) => {
  await mockPublic(page);
  let called = false;
  await page.route('**/api/auth/signup', r => { called = true; r.fulfill({ status: 201, json: {} }); });
  await page.goto('/#/signup');
  await page.getByPlaceholder('you@company.com').fill('a@b.com');
  await page.getByPlaceholder('••••••••').fill('supersecret1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText(/Terms/i);
  // Our privacy policy claims the user agreed to it, so we must not create an
  // account without evidence they did.
  expect(called).toBe(false);
});

test('the signup consent links point at the real legal pages', async ({ page }) => {
  await mockPublic(page);
  await page.goto('/#/signup');
  await expect(page.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms-and-conditions');
  await expect(page.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy-policy');
});

test('signup under a partner slug sends the slug AND shows partner branding', async ({ page }) => {
  await mockPublic(page);
  await page.route('**/api/branding/by-slug/*', r => r.fulfill({
    json: { found: true, isCustom: true, brandName: 'Skyline CRM', primaryColor: '#1183B4', loginTagline: 'Chat, the Skyline way' },
  }));
  let body = null;
  await page.route('**/api/auth/signup', async r => {
    body = r.request().postDataJSON();
    await r.fulfill({ status: 201, json: { verificationRequired: true, email: body.email, emailSent: true } });
  });

  await page.goto(`/?w=skyline`);
  // A partner link must skip our marketing page entirely.
  await expect(page.getByRole('heading', { name: 'Chat, the Skyline way' })).toBeVisible();
  // exact: the brand name also appears inside "Sign in to your Skyline CRM workspace".
  await expect(page.getByText('Skyline CRM', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByPlaceholder('you@company.com').fill('new@customer.com');
  await page.getByPlaceholder('••••••••').fill('supersecret1');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  expect(body.partnerSlug).toBe('skyline');
});

test('a partner visitor never sees our brand on the login screen', async ({ page }) => {
  await mockPublic(page);
  await page.route('**/api/branding/by-slug/*', r => r.fulfill({
    json: { found: true, isCustom: true, brandName: 'Skyline CRM', primaryColor: '#1183B4' },
  }));
  await page.goto(`/?w=skyline`);
  // exact: the brand name also appears inside "Sign in to your Skyline CRM workspace".
  await expect(page.getByText('Skyline CRM', { exact: true })).toBeVisible();
  // The Zen Chat watermark is suppressed for white-label.
  await expect(page.locator('img[alt="Zen Chat"]')).toHaveCount(0);
  // And there's no "Back to home" to our marketing page.
  await expect(page.getByRole('button', { name: 'Back to home' })).toHaveCount(0);
});

test('server-side signup errors surface to the user', async ({ page }) => {
  await mockPublic(page);
  await page.route('**/api/auth/signup', r => r.fulfill({
    status: 409, json: { error: 'An account with this email already exists. Try signing in.' },
  }));
  await page.goto(`/#/signup`);
  await page.getByPlaceholder('you@company.com').fill('taken@acme.com');
  await page.getByPlaceholder('••••••••').fill('supersecret1');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('already exists');
});

test('short passwords are rejected before hitting the network', async ({ page }) => {
  await mockPublic(page);
  let called = false;
  await page.route('**/api/auth/signup', r => { called = true; r.fulfill({ status: 201, json: {} }); });
  await page.goto(`/#/signup`);
  await page.getByPlaceholder('you@company.com').fill('a@b.com');
  await page.getByPlaceholder('••••••••').fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('at least 8 characters');
  expect(called).toBe(false);
});

test('the email confirmation link signs the user in', async ({ page }) => {
  // Playwright matches routes LAST-registered-first, so the catch-all has to be
  // registered BEFORE the specific handlers or it swallows them.
  await page.route('**/api/**', r => r.fulfill({ json: [] }));
  await page.route('**/api/billing/entitlements', r => r.fulfill({ json: { features: [], limits: {}, catalog: { plans: [], features: [] }, subscription: { locked: false } } }));
  await mockPublic(page);
  let sentToken = null;
  await page.route('**/api/auth/verify-email', async r => {
    sentToken = r.request().postDataJSON().token;
    await r.fulfill({
      json: { user: { id: 9, username: 'priya', email: 'priya@acme.com', displayName: 'Priya', role: 'admin', tenantId: 3, pages: ['home'], isSuperAdmin: false, isResellerAdmin: false, assignedWaNumbers: [] } },
    });
  });

  await page.goto(`/?verify=tok_abc123`);
  await expect(page.getByText(/Confirming your email|Loading/i)).toBeVisible({ timeout: 2000 }).catch(() => {});
  // Landed inside the app, not on the login screen.
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0, { timeout: 8000 });
  expect(sentToken).toBe('tok_abc123');
  // The single-use token must be stripped from the URL.
  await expect.poll(() => new URL(page.url()).searchParams.get('verify')).toBeNull();
});

test('an expired confirmation link explains itself instead of failing silently', async ({ page }) => {
  await mockPublic(page);
  await page.route('**/api/auth/verify-email', r => r.fulfill({
    status: 400, json: { error: 'This confirmation link is invalid or has expired. Request a new one.', code: 'VERIFY_INVALID' },
  }));
  await page.goto(`/?verify=expired`);
  await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
  await page.getByRole('button', { name: 'Go to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('Facebook button appears on signup with signup-flavoured copy', async ({ page }) => {
  await mockPublic(page, { fbEnabled: true });
  await page.goto(`/#/signup`);
  await expect(page.getByRole('button', { name: 'Continue with Facebook' })).toBeVisible();
  await page.getByRole('tab', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with Facebook' })).toBeVisible();
});
