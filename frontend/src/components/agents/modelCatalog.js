// LLM provider catalog — fetched from the backend, which owns it.
//
// This file used to hold a hardcoded copy of every provider's model list, with a
// "keep in sync with backend/src/llm/*" comment. It didn't stay in sync — the
// backend's second copy (mcpService.js) had already drifted to include a
// `claude_code` provider that existed nowhere else. Comments aren't a mechanism.
//
// Now the backend serves GET /api/ai-models/providers from llm/providers.js (the
// single source of truth) and this module caches it. Adding a provider is one
// edit, server-side, and every dropdown picks it up with no frontend change.
//
// The exported function names are unchanged so the ~4 call sites don't move; the
// sync ones now read from the cache and are safe to call before it loads (they
// return empty, and the UI re-renders when useProviderCatalog resolves).

import { useEffect, useState } from 'react';
import { api } from '../../api.js';

let cache = null;          // Array<providerMeta> once loaded
let inflight = null;       // de-dupe concurrent loaders

export async function loadProviderCatalog() {
  if (cache) return cache;
  if (!inflight) {
    inflight = api.aiModels.providers()
      .then(r => { cache = r.providers || []; return cache; })
      .catch(() => {
        // Never throw into a dropdown. An empty catalog renders "no models" and
        // the operator can still type a custom id — degraded, not broken.
        cache = [];
        return cache;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** React hook: the catalog, loading once per session. */
export function useProviderCatalog() {
  const [providers, setProviders] = useState(cache || []);
  const [loading, setLoading] = useState(!cache);
  useEffect(() => {
    let alive = true;
    if (cache) { setProviders(cache); setLoading(false); return; }
    loadProviderCatalog().then(list => {
      if (!alive) return;
      setProviders(list);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);
  return { providers, loading };
}

function metaFor(provider) {
  return (cache || []).find(p => p.id === provider) || null;
}

/** Models for a provider. Empty until the catalog loads. */
export function modelsForProvider(provider) {
  const m = metaFor(provider);
  return m ? m.models : [];
}

/** "Anthropic Claude — My key" */
export function providerDisplay(provider, label) {
  const m = metaFor(provider);
  const base = (m && m.label) || provider || 'Unknown';
  return label ? `${base} — ${label}` : base;
}

/** The provider's suggested default model, for a fresh agent. */
export function defaultModelFor(provider) {
  const m = metaFor(provider);
  return (m && m.defaultModel) || '';
}

export function supportsBaseUrl(provider) {
  const m = metaFor(provider);
  return !!(m && m.supportsBaseUrl);
}
