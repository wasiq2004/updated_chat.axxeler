// Factory for OpenAI-wire-format providers.
//
// Groq, Gemini and DeepSeek all speak the OpenAI chat-completions protocol, so
// they need no SDK of their own — only a different base URL on the shared
// tool-use loop in ./openaiCompatible.js. Each gets its own one-line file so the
// registry still reads as one-file-per-provider, but the logic lives here once.
//
// NATIVE providers (anthropic) do NOT use this. They keep their own adapter and
// must never be handed a baseURL — that would route them at the wrong host.
//
// Precedence, most specific first:
//   1. opts.baseURL          — the per-credential override (ai_models.base_url),
//                              for gateways like OpenRouter
//   2. <PROVIDER>_BASE_URL   — an env override, for a whole-install redirect
//   3. metadata defaultBaseUrl
//
// (1) exists because the original groq adapter spread `{...opts, baseURL: CONST}`
// — constant last — which silently discarded any caller-supplied baseURL. The
// per-credential override would have been accepted by the UI, stored in the DB,
// and then ignored at call time.

const { runWithTools: runCompatible } = require('./openaiCompatible');
const { getProviderMeta } = require('./providers');

function makeCompatAdapter(providerId) {
  const envVar = `${providerId.toUpperCase()}_BASE_URL`;

  async function runWithTools(opts) {
    const meta = getProviderMeta(providerId);
    const baseURL =
      (opts.baseURL && String(opts.baseURL).trim()) ||
      (process.env[envVar] && String(process.env[envVar]).trim()) ||
      (meta && meta.defaultBaseUrl) ||
      null;
    // baseURL null => openaiCompatible constructs the client with no baseURL,
    // i.e. the provider's own endpoint. That's what plain OpenAI wants.
    return runCompatible({ ...opts, baseURL });
  }

  return { runWithTools };
}

module.exports = { makeCompatAdapter };
