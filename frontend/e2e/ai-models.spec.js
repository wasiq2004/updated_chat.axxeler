// AI Models settings — provider rail + detail panel, fed by the SERVED catalog.
//
// The provider list used to be hardcoded here, so a provider the engine
// supported was invisible in settings and its key could not be connected at all.
// These tests drive the real page against the real catalog shape.
import { test, expect } from '@playwright/test';

const ADMIN = {
  id: 9, username: 'priya', email: 'p@a.com', displayName: 'Priya', role: 'admin',
  tenantId: 3, resellerId: null, isSuperAdmin: false, isResellerAdmin: false,
  pages: ['home', 'admin-settings:general', 'admin-settings:integrations'],
  assignedWaNumbers: [], permissions: null, isActive: true,
  passwordSet: true, facebookLinked: false, signupSource: 'invite',
};

// Mirrors backend/src/llm/providers.js publicCatalog().
const CATALOG = [
  { id: 'anthropic', label: 'Anthropic Claude', keyHint: 'sk-ant-…', supportsBaseUrl: false, defaultBaseUrl: null, defaultModel: 'claude-haiku-4-5-20251001', docsUrl: 'https://console.anthropic.com/settings/keys', envKey: 'ANTHROPIC_API_KEY', models: [{ value: 'claude-haiku-4-5-20251001', label: 'Haiku' }] },
  { id: 'openai', label: 'OpenAI', keyHint: 'sk-…', supportsBaseUrl: true, defaultBaseUrl: null, defaultModel: 'gpt-4o-mini', docsUrl: 'https://platform.openai.com/api-keys', envKey: 'OPENAI_API_KEY', models: [{ value: 'gpt-4o-mini', label: 'GPT-4o mini' }] },
  { id: 'groq', label: 'Groq', keyHint: 'gsk_…', supportsBaseUrl: true, defaultBaseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', docsUrl: 'https://console.groq.com/keys', envKey: 'GROQ_API_KEY', models: [{ value: 'llama-3.3-70b-versatile', label: 'Llama 3.3' }] },
  { id: 'gemini', label: 'Google Gemini', keyHint: 'AIza…', supportsBaseUrl: true, defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModel: 'gemini-2.0-flash', docsUrl: 'https://aistudio.google.com/app/apikey', envKey: 'GEMINI_API_KEY', models: [{ value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' }] },
  { id: 'deepseek', label: 'DeepSeek', keyHint: 'sk-…', supportsBaseUrl: true, defaultBaseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', docsUrl: 'https://platform.deepseek.com/api_keys', envKey: 'DEEPSEEK_API_KEY', models: [{ value: 'deepseek-chat', label: 'DeepSeek Chat' }] },
];

async function mockApp(page, { models = [] } = {}) {
  await page.route('**/api/**', r => r.fulfill({ json: [] }));
  await page.route('**/api/dashboard**', r => r.fulfill({ json: { kpis: [], alerts: [], funnel: { stages: [] }, tagDistribution: [] } }));
  await page.route('**/api/auth/status', r => r.fulfill({ json: { setupRequired: false } }));
  await page.route('**/api/auth/me', r => r.fulfill({ json: { user: ADMIN } }));
  await page.route('**/api/public-config', r => r.fulfill({ json: { facebook: { enabled: false }, emailVerification: false } }));
  await page.route('**/api/billing/entitlements', r => r.fulfill({
    json: { features: [], limits: {}, catalog: { plans: [], features: [] }, subscription: { locked: false }, branding: null },
  }));
  await page.route('**/api/ai-models/providers', r => r.fulfill({ json: { providers: CATALOG } }));
  await page.route('**/api/ai-models', r => {
    if (r.request().method() === 'GET') return r.fulfill({ json: models });
    return r.fallback();
  });
}

async function gotoTab(page) {
  await page.goto('/#/admin-settings/integrations/ai-models');
  await expect(page.getByRole('heading', { name: 'AI Models' })).toBeVisible();
}

test('every provider from the served catalog gets a rail entry', async ({ page }) => {
  await mockApp(page);
  await gotoTab(page);
  for (const p of CATALOG) {
    await expect(page.getByRole('button', { name: new RegExp(p.label) })).toBeVisible();
  }
});

test('the new providers are connectable — the whole point of the feature', async ({ page }) => {
  await mockApp(page);
  await gotoTab(page);
  // Hardcoded here before, so these two literally could not be added.
  await page.getByRole('button', { name: /Google Gemini/ }).click();
  await expect(page.getByText('Keys look like')).toBeVisible();
  await expect(page.getByText('AIza…')).toBeVisible();
  await page.getByRole('button', { name: /DeepSeek/ }).click();
  await expect(page.getByText('No DeepSeek key connected')).toBeVisible();
});

test('a compat provider offers a base URL; a native one never does', async ({ page }) => {
  await mockApp(page);
  await gotoTab(page);

  await page.getByRole('button', { name: /Google Gemini/ }).click();
  await page.getByRole('button', { name: 'Add key' }).first().click();
  await expect(page.getByText('Custom base URL (optional)')).toBeVisible();

  // Anthropic uses its own SDK — a base URL would route Claude at the wrong host.
  await page.getByRole('button', { name: /Anthropic Claude/ }).click();
  await page.getByRole('button', { name: 'Add key' }).first().click();
  await expect(page.getByText('Custom base URL (optional)')).toHaveCount(0);
});

test('saving posts the provider, key and base URL', async ({ page }) => {
  await mockApp(page);
  let body = null;
  await page.route('**/api/ai-models', async r => {
    if (r.request().method() === 'POST') {
      body = r.request().postDataJSON();
      return r.fulfill({ status: 201, json: { id: 1, provider: body.provider } });
    }
    return r.fulfill({ json: [] });
  });
  await gotoTab(page);
  await page.getByRole('button', { name: /Google Gemini/ }).click();
  await page.getByRole('button', { name: 'Add key' }).first().click();
  await page.getByPlaceholder('AIza…').fill('AIzaTESTKEY');
  await page.getByPlaceholder('https://generativelanguage.googleapis.com/v1beta/openai/').fill('https://gateway.example.com/v1');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect.poll(() => body).not.toBeNull();
  expect(body).toMatchObject({
    provider: 'gemini',
    apiKey: 'AIzaTESTKEY',
    baseUrl: 'https://gateway.example.com/v1',
  });
});

test('a native provider never sends a base URL even if one lingers', async ({ page }) => {
  await mockApp(page);
  let body = null;
  await page.route('**/api/ai-models', async r => {
    if (r.request().method() === 'POST') { body = r.request().postDataJSON(); return r.fulfill({ status: 201, json: { id: 1 } }); }
    return r.fulfill({ json: [] });
  });
  await gotoTab(page);
  await page.getByRole('button', { name: /Anthropic Claude/ }).click();
  await page.getByRole('button', { name: 'Add key' }).first().click();
  await page.getByPlaceholder('sk-ant-…').fill('sk-ant-TEST');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect.poll(() => body).not.toBeNull();
  expect(body.baseUrl).toBeNull();
});

test('the rail shows which providers are connected', async ({ page }) => {
  await mockApp(page, {
    models: [{ id: 1, provider: 'groq', label: 'Prod', apiKeyMasked: 'gsk_…abcd', baseUrl: null, supportsBaseUrl: true }],
  });
  await gotoTab(page);
  // Connection state at a glance is the reason to open this page.
  await expect(page.getByTitle('1 key connected')).toBeVisible();
});

test('a stored gateway override is shown, not hidden', async ({ page }) => {
  await mockApp(page, {
    models: [{ id: 1, provider: 'groq', label: 'Via gateway', apiKeyMasked: 'gsk_…abcd', baseUrl: 'https://openrouter.ai/api/v1', supportsBaseUrl: true }],
  });
  await gotoTab(page);
  await page.getByRole('button', { name: /Groq/ }).click();
  // It changes where the key is sent — discovering that in a failed agent run
  // would be a bad time.
  await expect(page.getByText('https://openrouter.ai/api/v1')).toBeVisible();
});

test('the model line-up for the selected provider is listed', async ({ page }) => {
  await mockApp(page);
  await gotoTab(page);
  await page.getByRole('button', { name: /DeepSeek/ }).click();
  await expect(page.getByText('Models available with this provider')).toBeVisible();
  await expect(page.getByText('deepseek-chat')).toBeVisible();
});

test('switching provider clears a key typed for the previous one', async ({ page }) => {
  await mockApp(page);
  await gotoTab(page);
  await page.getByRole('button', { name: /Google Gemini/ }).click();
  await page.getByRole('button', { name: 'Add key' }).first().click();
  await page.getByPlaceholder('AIza…').fill('AIzaLEAKED');
  await page.getByRole('button', { name: /DeepSeek/ }).click();
  await page.getByRole('button', { name: 'Add key' }).first().click();
  // A key typed for one provider must not silently carry into another's form.
  await expect(page.getByPlaceholder('sk-…')).toHaveValue('');
});

test('a failed save re-enables the form instead of dead-ending', async ({ page }) => {
  await mockApp(page);
  await page.route('**/api/ai-models', async r => {
    if (r.request().method() === 'POST') return r.fulfill({ status: 400, json: { error: 'Base URL must start with https://' } });
    return r.fulfill({ json: [] });
  });
  await gotoTab(page);
  await page.getByRole('button', { name: /Groq/ }).click();
  await page.getByRole('button', { name: 'Add key' }).first().click();
  await page.getByPlaceholder('gsk_…').fill('gsk_TEST');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('Base URL must start with https://')).toBeVisible();
  // `saving` stuck true would leave the button permanently disabled.
  await expect(page.getByRole('button', { name: 'Save key' })).toBeEnabled();
});
