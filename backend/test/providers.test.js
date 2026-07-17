// The provider catalog must have exactly ONE definition.
//
// It used to have ten. Adding a provider meant editing all ten, and missing one
// failed silently and differently each time — the SQL `IN (...)` filtered a
// connected credential out with no error; AI_DEFAULT_MODEL sent `model:
// undefined`; the model catalog rendered an empty dropdown. The "keep in sync"
// comments were not a mechanism: mcpService's PROVIDER_LABELS had already
// drifted to carry a `claude_code` key present in no other list.
//
// These tests are that mechanism. They fail if a consumer stops deriving from
// llm/providers.js — including by someone helpfully re-adding a literal.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const providers = require('../src/llm/providers');
const { listProviders, getProvider } = require('../src/llm');

const SRC = path.join(__dirname, '..', 'src');

test('every catalogued provider has a working adapter', () => {
  // The catalog (labels/models/env) and the registry (code) are separate files;
  // a provider in one but not the other is the drift this whole exercise is about.
  for (const id of providers.PROVIDER_IDS) {
    const adapter = getProvider(id);
    assert.equal(typeof adapter.runWithTools, 'function', `${id} has no runWithTools`);
  }
});

test('the registry and the catalog list exactly the same providers', () => {
  assert.deepEqual(listProviders().sort(), [...providers.PROVIDER_IDS].sort());
});

test('the new providers are actually registered', () => {
  // Guards the specific ask: Gemini + DeepSeek alongside the existing three.
  for (const id of ['anthropic', 'openai', 'groq', 'gemini', 'deepseek']) {
    assert.ok(providers.isSupportedProvider(id), `${id} missing from the catalog`);
  }
});

test('every provider carries the metadata each consumer needs', () => {
  for (const id of providers.PROVIDER_IDS) {
    const m = providers.getProviderMeta(id);
    assert.equal(m.id, id, `${id}: id mismatch`);
    assert.ok(m.label, `${id}: no label (settings UI)`);
    assert.ok(m.envKey, `${id}: no envKey (env fallback)`);
    assert.ok(m.defaultModel, `${id}: no defaultModel — automation AI node would send model: undefined`);
    assert.ok(Array.isArray(m.models) && m.models.length, `${id}: no models (empty dropdown)`);
    assert.equal(typeof m.supportsBaseUrl, 'boolean', `${id}: supportsBaseUrl must be explicit`);
  }
});

test('a defaultModel is one the catalog actually offers', () => {
  // A default outside the catalog means the UI shows a model the engine won't use.
  for (const id of providers.PROVIDER_IDS) {
    const m = providers.getProviderMeta(id);
    const values = m.models.map(x => x.value);
    assert.ok(values.includes(m.defaultModel), `${id}: defaultModel '${m.defaultModel}' not in its own model list`);
  }
});

test('derived maps cover every provider — no silent gaps', () => {
  const labels = providers.providerLabels();
  const envs = providers.providerEnvKeys();
  const defaults = providers.providerDefaultModels();
  for (const id of providers.PROVIDER_IDS) {
    assert.ok(labels[id], `providerLabels() missing ${id}`);
    assert.ok(envs[id], `providerEnvKeys() missing ${id}`);
    assert.ok(defaults[id], `providerDefaultModels() missing ${id}`);
  }
  assert.equal(Object.keys(labels).length, providers.PROVIDER_IDS.length);
});

test('a NATIVE provider can never be handed a base URL', () => {
  // anthropic uses its own SDK. Injecting a baseURL would route Claude at the
  // wrong host — the spec's explicit trap.
  assert.equal(providers.getProviderMeta('anthropic').supportsBaseUrl, false);
  assert.equal(providers.resolveBaseUrl('anthropic', 'https://evil.example.com/v1'), null,
    'a stored override leaked into a native provider');
});

test('resolveBaseUrl prefers the credential override, then the default', () => {
  assert.equal(providers.resolveBaseUrl('groq', 'https://gateway.example.com/v1'), 'https://gateway.example.com/v1');
  assert.equal(providers.resolveBaseUrl('groq', ''), 'https://api.groq.com/openai/v1');
  assert.equal(providers.resolveBaseUrl('groq', null), 'https://api.groq.com/openai/v1');
  assert.equal(providers.resolveBaseUrl('groq', '   '), 'https://api.groq.com/openai/v1', 'whitespace must not count as an override');
  // OpenAI has no default: no override => no baseURL => the SDK's own endpoint,
  // byte-identical to the behaviour before this refactor.
  assert.equal(providers.resolveBaseUrl('openai', null), null);
  assert.equal(providers.resolveBaseUrl('openai', 'https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1');
  // Unknown provider must not invent an endpoint.
  assert.equal(providers.resolveBaseUrl('nope', 'https://x.example.com'), null);
});

test('the compat providers have a default endpoint; only OpenAI omits one', () => {
  for (const id of ['groq', 'gemini', 'deepseek']) {
    const m = providers.getProviderMeta(id);
    assert.ok(m.supportsBaseUrl, `${id} must be reachable via the compat adapter`);
    assert.match(m.defaultBaseUrl || '', /^https:\/\//, `${id}: defaultBaseUrl must be an https URL`);
  }
  assert.equal(providers.getProviderMeta('openai').defaultBaseUrl, null,
    'OpenAI must default to its own SDK endpoint, not a hardcoded URL');
});

test('supportedHint names every provider, so the error message cannot drift', () => {
  const hint = providers.supportedHint();
  for (const id of providers.PROVIDER_IDS) {
    assert.ok(hint.includes(`'${id}'`), `supportedHint() omits ${id}: "${hint}"`);
  }
});

test('publicCatalog exposes what the UI needs and no secrets', () => {
  // This payload is served to the browser, so assert on the real risk: an env
  // VALUE. The env NAME and the keyHint ('sk-…') are deliberately included —
  // they're placeholders the settings form renders, not credentials.
  const canary = 'sk-CANARY-must-not-be-served-0123456789';
  const saved = {};
  for (const id of providers.PROVIDER_IDS) {
    const k = providers.getProviderMeta(id).envKey;
    saved[k] = process.env[k];
    process.env[k] = canary;
  }
  try {
    const cat = providers.publicCatalog();
    assert.equal(cat.length, providers.PROVIDER_IDS.length);
    assert.ok(!JSON.stringify(cat).includes(canary), 'publicCatalog served a real API key to the browser');
    for (const p of cat) {
      assert.ok(p.id && p.label && Array.isArray(p.models), `${p.id}: incomplete entry`);
      assert.ok(p.keyHint, `${p.id}: no keyHint for the settings form`);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// ── The drift guard proper ───────────────────────────────────────────────────
// Static scan: catch a literal list creeping back in. Greping is crude, but it's
// the only thing that fails when someone writes a NEW hardcoded list rather than
// editing an existing one — which is exactly how this happened the first time.

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

test('no consumer hardcodes the provider set any more', () => {
  const offenders = [];
  const checks = [
    // [file, regex, what it used to be]
    ['routes/aiModels.js', /new Set\(\s*\[\s*'anthropic'/, 'SUPPORTED Set'],
    ['routes/agents.js', /new Set\(\s*\[\s*'anthropic'/, 'SUPPORTED_PROVIDERS Set'],
    ['services/agentService.js', /new Set\(\s*\[\s*'anthropic'/, 'SUPPORTED_PROVIDERS Set'],
    ['engine/agentEngine.js', /PROVIDER_ENV_KEY\s*=\s*\{\s*\n?\s*anthropic:/, 'PROVIDER_ENV_KEY literal'],
    ['engine/automationEngine.js', /AI_DEFAULT_MODEL\s*=\s*\{\s*anthropic:/, 'AI_DEFAULT_MODEL literal'],
  ];
  for (const [file, re, what] of checks) {
    if (re.test(read(file))) offenders.push(`${file}: ${what} is hardcoded again`);
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}\n  Derive from llm/providers.js instead.`);
});

test('the automation engine does not filter providers with a SQL literal', () => {
  const src = read('engine/automationEngine.js');
  // The worst one: a connected credential for an unlisted provider was dropped
  // by the database, and the flow reported "no AI model connected".
  assert.ok(!/provider IN \('anthropic'/.test(src),
    "automationEngine still has provider IN ('anthropic',...) — use = ANY($1) with PROVIDER_IDS");
  assert.ok(/provider = ANY\(/.test(src),
    'automationEngine should select providers with = ANY($1::text[])');
});

test('the automation engine reads base_url, which was dormant since migration 029', () => {
  const src = read('engine/automationEngine.js');
  assert.ok(/base_url/.test(src), 'automationEngine must select base_url or overrides are silently ignored');
});
