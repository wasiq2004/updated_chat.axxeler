// Groq adapter. Groq exposes an OpenAI-compatible chat-completions API, so we
// reuse the shared OpenAI-format tool-use loop (./openaiCompatible.js) and only
// point it at Groq's base URL. Model ids (e.g. llama-3.3-70b-versatile) are
// chosen per-agent from the model catalog; keys are `gsk_…`. See ./index.js for
// the adapter contract and ./compat.js for base-URL precedence
// (per-credential override > GROQ_BASE_URL > default).

const { makeCompatAdapter } = require('./compat');

module.exports = makeCompatAdapter('groq');
