// OpenAI adapter. The tool-use loop lives in ./openaiCompatible.js (shared with
// the Groq adapter, which speaks the same API). OpenAI uses the SDK default
// base URL, so we forward the call unchanged with no baseURL override.

const { runWithTools } = require('./openaiCompatible');

module.exports = { runWithTools };
