// Groq adapter. Groq exposes an OpenAI-compatible chat-completions API, so we
// reuse the shared OpenAI-format tool-use loop (./openaiCompatible.js) and only
// point it at Groq's base URL. Model ids (e.g. llama-3.3-70b-versatile) are
// chosen per-agent from the model catalog; keys are `gsk_…`. See ./index.js for
// the adapter contract.

const { runWithTools: runCompatible } = require('./openaiCompatible');

const GROQ_BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';

async function runWithTools(opts) {
  return runCompatible({ ...opts, baseURL: GROQ_BASE_URL });
}

module.exports = { runWithTools };
