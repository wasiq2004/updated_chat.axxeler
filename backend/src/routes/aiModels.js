// AI Models registry — workspace-wide LLM provider credentials.
//
// One row per (provider, API key) the workspace has connected. Agents reference
// a row by id (coexistence.agents.ai_model_id) instead of carrying their own
// key, so a key is configured once (Admin Settings → Integrations → AI Models)
// and rotating it updates every agent at once. Keys are AES-256-GCM at rest
// (util/crypto.js) and never returned in plaintext except via ?reveal=1 on the
// single-row GET, which is gated to admins.
//
// Supports whichever providers the agent engine has tool-use adapters for —
// see llm/providers.js, the single source of truth. The exact model (e.g.
// gpt-4o-mini, llama-3.3-70b-versatile) is chosen per-agent in the agent editor;
// this registry only stores the provider + credential (+ an optional base-URL
// override for gateways like OpenRouter).

const { Router } = require('express');
const pool = require('../db');
const { encrypt, decrypt, maskSecret } = require('../util/crypto');
const { adminOnly, scopeClause } = require('../middleware/access');
const {
  PROVIDER_IDS, isSupportedProvider, providerLabels, supportedHint, publicCatalog, getProviderMeta,
} = require('../llm/providers');

const router = Router();

// All three of these were hand-maintained here — including SUPPORTED_HINT, a
// prose string with a "kept in sync with SUPPORTED" comment doing the work a
// derivation should. Now generated.
const SUPPORTED = new Set(PROVIDER_IDS);
const PROVIDER_LABELS = providerLabels();
const SUPPORTED_HINT = supportedHint();

// Listing models is needed by the agent editor, which non-admin operators with
// agent access may open — so list/get(masked) only require authentication.
// Mutations and plaintext reveal require admin (they manage a shared secret).
function authed(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function shape(row, { reveal = false } = {}) {
  if (!row) return null;
  const apiKey = decrypt(row.api_key_encrypted);
  const meta = getProviderMeta(row.provider);
  return {
    id: row.id,
    provider: row.provider,
    providerLabel: PROVIDER_LABELS[row.provider] || row.provider,
    label: row.label || null,
    apiKeyMasked: maskSecret(apiKey || ''),
    apiKey: reveal ? (apiKey || '') : undefined,
    // base_url has existed since migration 029 and was never returned, so the UI
    // had no way to show or edit an override that the engine (also) ignored.
    baseUrl: row.base_url || null,
    supportsBaseUrl: !!(meta && meta.supportsBaseUrl),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// A base URL is only meaningful for OpenAI-compatible providers. Returning null
// for a native one is what stops a stale override surviving a provider switch
// and misrouting Claude at someone's OpenRouter gateway.
function normaliseBaseUrl(provider, raw) {
  const meta = getProviderMeta(provider);
  if (!meta || !meta.supportsBaseUrl) return null;
  const v = String(raw || '').trim();
  if (!v) return null;
  if (!/^https:\/\//i.test(v)) {
    const err = new Error('Base URL must start with https://');
    err.status = 400;
    throw err;
  }
  return v;
}

// GET /ai-models/providers — the catalog the UI renders.
//
// Served rather than duplicated in the frontend: the model catalog previously
// existed twice (frontend/components/agents/modelCatalog.js and
// backend/services/mcpService.js) with "keep in sync" comments, and had already
// drifted. Now there is one list and the browser asks for it.
router.get('/ai-models/providers', authed, (req, res) => {
  res.json({ providers: publicCatalog() });
});

// List — any authenticated user (the agent editor needs this).
router.get('/ai-models', authed, async (req, res) => {
  try {
    const params = [];
    const where = scopeClause(req, null, params, { leading: 'WHERE ' });
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.ai_models ${where} ORDER BY created_at DESC`,
      params,
    );
    res.json(rows.map(r => shape(r)));
  } catch (err) {
    console.error('[ai-models] list error:', err.message);
    res.status(500).json({ error: 'Failed to list AI models' });
  }
});

// Get one — plaintext key only with ?reveal=1 AND admin role.
router.get('/ai-models/:id', authed, async (req, res) => {
  try {
    const idParams = [req.params.id];
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.ai_models WHERE id = $1${scopeClause(req, null, idParams)}`,
      idParams,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const reveal = req.query.reveal === '1' && req.user?.role === 'admin';
    res.json(shape(rows[0], { reveal }));
  } catch (err) {
    console.error('[ai-models] get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch AI model' });
  }
});

// Create — admin only. Body: { provider, apiKey, label?, baseUrl? }
router.post('/ai-models', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const provider = String(b.provider || '').trim().toLowerCase();
    const apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
    if (!provider || !apiKey) {
      return res.status(400).json({ error: 'provider and apiKey are required' });
    }
    if (!SUPPORTED.has(provider)) {
      return res.status(400).json({ error: SUPPORTED_HINT });
    }
    const baseUrl = normaliseBaseUrl(provider, b.baseUrl);
    const { rows } = await pool.query(
      `INSERT INTO coexistence.ai_models (provider, label, api_key_encrypted, base_url, available_models, tenant_id)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, $5)
       RETURNING *`,
      [provider, b.label?.trim() || null, encrypt(apiKey), baseUrl, req.tenantId ?? null],
    );
    res.status(201).json(shape(rows[0]));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[ai-models] create error:', err.message);
    res.status(500).json({ error: 'Failed to add AI model' });
  }
});

// Update — admin only. Rotate the key and/or rename. An empty-string apiKey is
// rejected (a registry row must always hold a usable key); omit apiKey to keep
// the existing one.
router.put('/ai-models/:id', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;
    const push = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };

    // The provider decides whether a base URL is even legal, so resolve it first
    // — including when only the provider is changing and baseUrl wasn't sent.
    let effProvider = null;
    if (b.provider !== undefined) {
      effProvider = String(b.provider).trim().toLowerCase();
      if (!SUPPORTED.has(effProvider)) {
        return res.status(400).json({ error: SUPPORTED_HINT });
      }
      push('provider', effProvider);
    }
    if (b.label !== undefined) push('label', b.label?.trim() || null);

    if (b.baseUrl !== undefined || effProvider !== null) {
      // Which provider will this row BE after the update? A base URL sent
      // alongside a provider change must be validated against the new provider.
      const { rows: cur } = await pool.query('SELECT provider, base_url FROM coexistence.ai_models WHERE id = $1', [req.params.id]);
      if (!cur.length) return res.status(404).json({ error: 'Not found' });
      const target = effProvider || cur[0].provider;
      const raw = b.baseUrl !== undefined ? b.baseUrl : cur[0].base_url;
      // normaliseBaseUrl returns null for a provider that doesn't support one —
      // so switching a compat provider to a native one CLEARS the stale override
      // rather than leaving it to misroute the native provider at the old host.
      push('base_url', normaliseBaseUrl(target, raw));
    }
    if (b.apiKey !== undefined) {
      const key = String(b.apiKey).trim();
      if (!key) return res.status(400).json({ error: 'apiKey cannot be empty — omit it to keep the current key' });
      push('api_key_encrypted', encrypt(key));
    }

    if (sets.length === 1) return res.status(400).json({ error: 'No updatable fields provided' });

    params.push(req.params.id);
    const scope = scopeClause(req, null, params);
    const { rows } = await pool.query(
      `UPDATE coexistence.ai_models SET ${sets.join(', ')} WHERE id = $${i}${scope} RETURNING *`,
      params,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(shape(rows[0]));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('[ai-models] update error:', err.message);
    res.status(500).json({ error: 'Failed to update AI model' });
  }
});

// Delete — admin only. Agents referencing this model have ai_model_id set NULL
// by the FK (ON DELETE SET NULL); the agent editor then flags them as needing a
// model and the engine refuses to run them until one is re-selected.
router.delete('/ai-models/:id', adminOnly, async (req, res) => {
  try {
    // Demote any agents pointing at this model to drafts BEFORE deleting, while
    // the FK still matches. The FK's ON DELETE SET NULL only nulls ai_model_id —
    // it can't flip status/is_active, so an active agent would otherwise be left
    // marked active but unrunnable (engine refuses with no provider). Mirrors
    // the migration's fail-safe for env-key agents.
    const demoteParams = [req.params.id];
    const { rowCount: demoted } = await pool.query(
      `UPDATE coexistence.agents SET status = 'draft', is_active = FALSE, updated_at = NOW()
        WHERE ai_model_id = $1${scopeClause(req, null, demoteParams)}`,
      demoteParams,
    );
    const delParams = [req.params.id];
    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.ai_models WHERE id = $1${scopeClause(req, null, delParams)}`,
      delParams,
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, detachedAgents: demoted });
  } catch (err) {
    console.error('[ai-models] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete AI model' });
  }
});

module.exports = { router };
