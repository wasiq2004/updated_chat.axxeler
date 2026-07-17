// THE provider catalog. One definition, every consumer derives from it.
//
// Before this, the provider list was copy-pasted across ten sites — two
// SUPPORTED_PROVIDERS Sets, a SQL `provider IN (...)`, an env-var map, a default-
// model map, an env-fallback ladder, a prose error string, two model catalogs
// (one backend, one frontend), and a button row. Adding a provider meant editing
// all ten, and missing one failed SILENTLY in a different way each time:
//
//   * miss the SQL IN(...)      -> the row is filtered out; the automation says
//                                  "no AI model connected" while a valid key sits
//                                  in the table
//   * miss AI_DEFAULT_MODEL     -> model: undefined is sent to the API
//   * miss the model catalog    -> an empty model dropdown, no error
//
// Proof this is real, not theoretical: mcpService's PROVIDER_LABELS had already
// drifted to include a `claude_code` key that exists in no other list.
//
// providers.test.js fails if any consumer stops deriving from here.

// compat = OpenAI-wire-format, reached through llm/openaiCompatible.js with a
// baseURL. A NATIVE provider (anthropic) uses its own SDK and must never be
// handed a baseURL — that's why supportsBaseUrl is a per-provider fact and not
// "everything except openai".
const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    envKey: 'ANTHROPIC_API_KEY',
    keyHint: 'sk-ant-…',
    // Native SDK. Injecting a baseURL here would route Claude at the wrong host.
    supportsBaseUrl: false,
    defaultBaseUrl: null,
    defaultModel: 'claude-haiku-4-5-20251001',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (most capable)' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced)' },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fastest)' },
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    keyHint: 'sk-…',
    // OpenAI's own endpoint is the default (baseURL omitted), but a gateway
    // (OpenRouter, an enterprise proxy) is a legitimate override.
    supportsBaseUrl: true,
    defaultBaseUrl: null,
    defaultModel: 'gpt-4o-mini',
    docsUrl: 'https://platform.openai.com/api-keys',
    models: [
      { value: 'gpt-4o', label: 'GPT-4o' },
      { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
      { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    ],
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    keyHint: 'gsk_…',
    supportsBaseUrl: true,
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    docsUrl: 'https://console.groq.com/keys',
    models: [
      { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile (most capable)' },
      { value: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant (fastest)' },
      { value: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
      { value: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2 Instruct' },
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    keyHint: 'AIza…',
    supportsBaseUrl: true,
    // Google ships an OpenAI-compatibility endpoint, so this needs no new SDK.
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.0-flash',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    models: [
      { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (fast, default)' },
      { value: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash-Lite (cheapest)' },
      { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro (most capable)' },
    ],
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    keyHint: 'sk-…',
    supportsBaseUrl: true,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { value: 'deepseek-chat', label: 'DeepSeek Chat (V3)' },
      { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)' },
    ],
  },
};

const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

function getProviderMeta(id) {
  return PROVIDERS[id] || null;
}

function isSupportedProvider(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/** { anthropic: 'Anthropic Claude', ... } */
function providerLabels() {
  return Object.fromEntries(PROVIDER_IDS.map(id => [id, PROVIDERS[id].label]));
}

/** { anthropic: 'ANTHROPIC_API_KEY', ... } — env fallback when no key is stored. */
function providerEnvKeys() {
  return Object.fromEntries(PROVIDER_IDS.map(id => [id, PROVIDERS[id].envKey]));
}

/** { anthropic: 'claude-haiku-4-5-20251001', ... } */
function providerDefaultModels() {
  return Object.fromEntries(PROVIDER_IDS.map(id => [id, PROVIDERS[id].defaultModel]));
}

/**
 * The base URL to actually call for a stored credential.
 * `override` is ai_models.base_url — honoured only where the provider supports
 * it, so a stale override on a native provider can't misroute it.
 */
function resolveBaseUrl(id, override) {
  const meta = getProviderMeta(id);
  if (!meta || !meta.supportsBaseUrl) return null;
  const clean = String(override || '').trim();
  return clean || meta.defaultBaseUrl || null;
}

/** Prose for a validation error — was a hand-maintained string that drifted. */
function supportedHint() {
  const quoted = PROVIDER_IDS.map(p => `'${p}'`);
  const last = quoted.pop();
  return `provider must be ${quoted.join(', ')}, or ${last}`;
}

/** Safe for the browser: no env values, no keys — just what the UI must render. */
function publicCatalog() {
  return PROVIDER_IDS.map(id => {
    const p = PROVIDERS[id];
    return {
      id: p.id,
      label: p.label,
      keyHint: p.keyHint,
      supportsBaseUrl: p.supportsBaseUrl,
      defaultBaseUrl: p.defaultBaseUrl,
      defaultModel: p.defaultModel,
      docsUrl: p.docsUrl,
      models: p.models,
      // Purely informational: whether a key is present in env is not a secret,
      // and it explains "why does this work without me adding a key?".
      envKey: p.envKey,
    };
  });
}

module.exports = {
  PROVIDERS,
  PROVIDER_IDS,
  getProviderMeta,
  isSupportedProvider,
  providerLabels,
  providerEnvKeys,
  providerDefaultModels,
  resolveBaseUrl,
  supportedHint,
  publicCatalog,
};
