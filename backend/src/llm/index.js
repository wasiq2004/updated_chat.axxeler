// LLM provider registry. The agent engine asks for a provider by name and
// gets back a uniform `{ runWithTools(...) }` adapter. Adding a provider is a
// new file in this folder + one line below — the engine code never branches
// on provider name.
//
// Each adapter exports a single async function with this contract:
//
//   runWithTools({
//     systemPrompt: string,
//     messages: Array<{ role: 'user'|'assistant', content: string }>,
//     tools: Array<{ name, description, input_schema }>,
//     onToolCall: async ({ name, args }) => any,    // executes one tool and returns result
//     onStep: async (step) => void,                 // emits llm_call / tool_call traces
//     model: string,
//     apiKey: string,
//     maxIterations: number,
//   }) -> { finalText, totalInputTokens, totalOutputTokens, iterations }
//
// `tools` follows the Anthropic-style shape because it's the simpler superset;
// the OpenAI adapter translates internally. `onToolCall` errors are caught by
// the adapter and fed back to the model as a tool error — the loop continues
// until the model stops asking for tools (or maxIterations).

// `baseURL` is an optional extra opt honoured by the OpenAI-compatible adapters
// (openai/groq/gemini/deepseek) and ignored by native ones (anthropic). It
// carries ai_models.base_url so a credential can point at a gateway.
//
// The keys below MUST match llm/providers.js — providers.test.js fails if they
// drift. providers.js is the catalog (labels, env vars, models, base URLs); this
// file is the code behind each id.

const anthropic = require('./anthropic');
const openai = require('./openai');
const groq = require('./groq');
const gemini = require('./gemini');
const deepseek = require('./deepseek');

const PROVIDERS = {
  anthropic,
  openai,
  groq,
  gemini,
  deepseek,
};

function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) {
    const err = new Error(`Unknown LLM provider: ${name}`);
    err.code = 'UNKNOWN_PROVIDER';
    throw err;
  }
  return p;
}

function listProviders() {
  return Object.keys(PROVIDERS);
}

module.exports = { getProvider, listProviders };
