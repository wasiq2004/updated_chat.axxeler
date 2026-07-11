// Static catalog of selectable LLM models per provider.
//
// The AI Models registry (Admin Settings → Integrations → AI Models) stores the
// provider + API key; the exact model is chosen per-agent from this list.
// Supports Anthropic, OpenAI, and Groq — the providers the engine has tool-use
// adapters for. Keep these model ids in sync with backend/src/llm/* and
// backend/src/services/mcpService.js.

export const PROVIDER_LABELS = { anthropic: 'Anthropic Claude', openai: 'OpenAI', groq: 'Groq' };

export const MODEL_CATALOG = {
  anthropic: [
    { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (most capable)' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced)' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fastest)' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
  groq: [
    { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile (most capable)' },
    { value: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant (fastest)' },
    { value: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
    { value: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2 Instruct' },
  ],
};

export function modelsForProvider(provider) {
  return MODEL_CATALOG[provider] || [];
}

export function providerDisplay(provider, label) {
  const base = PROVIDER_LABELS[provider] || provider || 'Unknown';
  return label ? `${base} — ${label}` : base;
}
