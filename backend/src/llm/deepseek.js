// DeepSeek adapter.
//
// DeepSeek's API is OpenAI-compatible, so this reuses the shared OpenAI-format
// tool-use loop with a different base URL — no new SDK. Keys are `sk-…`; models
// are `deepseek-chat` (V3) and `deepseek-reasoner` (R1).
//
// See ./index.js for the adapter contract and ./compat.js for base-URL
// precedence (per-credential override > DEEPSEEK_BASE_URL > default).

const { makeCompatAdapter } = require('./compat');

module.exports = makeCompatAdapter('deepseek');
