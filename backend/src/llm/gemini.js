// Google Gemini adapter.
//
// Google ships an OpenAI-compatibility endpoint, so this needs no new SDK and no
// new tool-use loop — it's the shared OpenAI-format loop pointed at
// generativelanguage.googleapis.com. Keys are `AIza…`; model ids are
// `gemini-2.0-flash` etc.
//
// See ./index.js for the adapter contract and ./compat.js for base-URL
// precedence (per-credential override > GEMINI_BASE_URL > default).

const { makeCompatAdapter } = require('./compat');

module.exports = makeCompatAdapter('gemini');
