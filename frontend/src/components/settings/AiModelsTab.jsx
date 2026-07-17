import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Trash2, Loader2, Eye, EyeOff, KeyRound, Bot, RefreshCw, Check, ExternalLink, Link2 } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import DeleteConfirmModal from '../DeleteConfirmModal.jsx';
import { useProviderCatalog } from '../agents/modelCatalog.js';

/**
 * Integrations → AI Models.
 *
 * Workspace-wide LLM provider credentials. Each row is one (provider, API key)
 * the workspace has connected; AI Agents reference a row instead of carrying
 * their own key, so a key is pasted once here and rotating it updates every
 * agent.
 *
 * The provider list is FETCHED (GET /ai-models/providers), not hardcoded. It was
 * a literal array here, which meant a provider added to the engine was invisible
 * in settings — you could not connect a key for it at all, with no error to
 * explain why. See backend/src/llm/providers.js.
 *
 * Layout: provider rail + capped-width detail panel. The old design was a
 * full-width row of provider buttons with `flex: 1` each; at three providers it
 * already looked stretched, and each new one squeezed the row further.
 */
export default function AiModelsTab() {
  const { providers, loading: catalogLoading } = useProviderCatalog();
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setModels(await api.aiModels.list());
    } catch (e) {
      setError(prettyError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Land on a provider that's actually connected — that's what someone opening
  // this page usually came to look at.
  useEffect(() => {
    if (selected || !providers.length) return;
    const connected = providers.find(p => models.some(m => m.provider === p.id));
    setSelected((connected || providers[0]).id);
  }, [providers, models, selected]);

  const byProvider = useMemo(() => {
    const map = {};
    for (const p of providers) map[p.id] = [];
    for (const m of models) (map[m.provider] = map[m.provider] || []).push(m);
    return map;
  }, [providers, models]);

  const meta = providers.find(p => p.id === selected) || null;
  const rows = byProvider[selected] || [];

  const handleDelete = async (id) => {
    try {
      await api.aiModels.delete(id);
      setPendingDelete(null);
      await refresh();
    } catch (e) {
      setError(prettyError(e));
      setPendingDelete(null);
    }
  };

  if (catalogLoading) {
    return (
      <div style={{ flex: 1, padding: 40, fontFamily: FONT, color: C.textMuted, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Loading providers…
      </div>
    );
  }

  return (
    <div style={{ flex: 1, padding: '32px 40px', overflowY: 'auto', fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 22, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em' }}>AI Models</h1>
          <p style={{ fontSize: 12, color: C.textMuted, margin: '4px 0 0' }}>
            {/* Derived, so this line can't go stale the way "Anthropic, OpenAI,
                or Groq" did the moment a fourth provider landed. */}
            Connect a key once — {providers.map(p => p.label).join(', ')}. AI Agents pick a connected provider; no per-agent keys.
          </p>
        </div>
        <button onClick={refresh} disabled={loading} title="Refresh" style={ghostBtn(loading)}>
          <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} /> Refresh
        </button>
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, marginBottom: 16, maxWidth: 900,
          background: 'rgba(239,68,68,.14)', color: '#DC2626', border: '1px solid rgba(239,68,68,.3)', fontSize: 13,
        }}>{error}</div>
      )}

      <div className="ai-models-split" style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        {/* Provider rail */}
        <div style={{ width: 208, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {providers.map(p => {
            const count = (byProvider[p.id] || []).length;
            const on = p.id === selected;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => { setSelected(p.id); setAdding(false); }}
                aria-current={on ? 'true' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                  padding: '10px 12px', borderRadius: 9, cursor: 'pointer', fontFamily: FONT,
                  border: `1px solid ${on ? C.primary : 'transparent'}`,
                  background: on ? C.primaryLight : 'transparent',
                  color: on ? C.primary : C.text, fontSize: 13, fontWeight: on ? 700 : 500,
                }}
              >
                <Bot size={15} style={{ flexShrink: 0, opacity: on ? 1 : 0.6 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
                {count > 0 && (
                  // Connection state at a glance — the reason to open this page.
                  <span title={`${count} key${count > 1 ? 's' : ''} connected`} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    fontSize: 10.5, fontWeight: 800, color: '#0b7a3b',
                    background: 'rgba(37,211,102,.16)', padding: '2px 6px', borderRadius: 20,
                  }}>
                    <Check size={10} />{count > 1 ? count : ''}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Detail panel — capped so it reads as a panel, not a stretched row. */}
        <div style={{ flex: 1, minWidth: 0, maxWidth: 660 }}>
          {meta && (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{meta.label}</div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3 }}>
                    Keys look like <code style={{ fontFamily: MONO }}>{meta.keyHint}</code>
                    {meta.docsUrl && (
                      <> · <a href={meta.docsUrl} target="_blank" rel="noreferrer"
                        style={{ color: C.primary, fontWeight: 600, textDecoration: 'none' }}>
                        Get a key <ExternalLink size={10} style={{ verticalAlign: '-1px' }} />
                      </a></>
                    )}
                  </div>
                </div>
                {!adding && (
                  <button onClick={() => setAdding(true)} style={{ ...primaryBtn, flexShrink: 0 }}>
                    <Plus size={14} /> Add key
                  </button>
                )}
              </div>

              {adding && (
                <AddModelForm
                  meta={meta}
                  onCancel={() => setAdding(false)}
                  onCreated={async () => { setAdding(false); await refresh(); }}
                  onError={setError}
                />
              )}

              {loading && models.length === 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 30, color: C.textMuted, fontSize: 13 }}>
                  <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Loading…
                </div>
              ) : rows.length === 0 && !adding ? (
                <EmptyState meta={meta} onAdd={() => setAdding(true)} />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {rows.map(m => (
                    <ModelRow key={m.id} model={m} meta={meta} onDelete={() => setPendingDelete(m)} />
                  ))}
                </div>
              )}

              {/* The provider's model line-up — so it's obvious what connecting
                  this key actually buys, without opening the agent editor. */}
              <div style={{ marginTop: 22, padding: 16, borderRadius: 10, background: 'var(--c-surfaceAlt)', border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 10 }}>
                  Models available with this provider
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {meta.models.map(m => (
                    <span key={m.value} title={m.value} style={{
                      fontSize: 11.5, fontFamily: MONO, padding: '4px 9px', borderRadius: 6,
                      background: C.cardBg, border: `1px solid ${C.border}`, color: C.textSecondary,
                    }}>{m.value}</span>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 10, lineHeight: 1.5 }}>
                  Pick the exact model per agent — you can also type a custom id there if the provider
                  ships one that isn’t listed here.
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <DeleteConfirmModal
        open={!!pendingDelete}
        title="Remove this AI model?"
        message={pendingDelete
          ? `Agents using ${(providers.find(p => p.id === pendingDelete.provider)?.label) || pendingDelete.provider}${pendingDelete.label ? ` (${pendingDelete.label})` : ''} will be detached and need a new model selected before they can run.`
          : ''}
        confirmText="Remove"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => handleDelete(pendingDelete.id)}
      />

      <style>{`
        @media (max-width: 820px) {
          .ai-models-split { flex-direction: column !important; }
          .ai-models-split > div:first-child { width: 100% !important; flex-direction: row !important; flex-wrap: wrap; }
        }
      `}</style>
    </div>
  );
}

function AddModelForm({ meta, onCancel, onCreated, onError }) {
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset when switching provider — otherwise a key typed for one provider
  // silently carries into the next one's form.
  useEffect(() => { setLabel(''); setApiKey(''); setBaseUrl(''); setSaving(false); }, [meta.id]);

  const handleSave = async () => {
    if (!apiKey.trim()) { onError('Paste an API key first.'); return; }
    setSaving(true);
    onError('');
    try {
      await api.aiModels.create({
        provider: meta.id,
        label: label.trim() || null,
        apiKey: apiKey.trim(),
        // Omitted for a native provider — the server ignores it there anyway.
        baseUrl: meta.supportsBaseUrl ? (baseUrl.trim() || null) : null,
      });
      onCreated();
    } catch (e) {
      onError(prettyError(e));
      // Must reset here too: `saving` stuck true after a failure left the form
      // permanently disabled.
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 18, borderRadius: 12, background: C.cardBg, border: `1px solid ${C.border}`, marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>Add a {meta.label} key</div>

      <div style={{ marginBottom: 14 }}>
        <FieldLabel>Name (optional)</FieldLabel>
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Production key" style={inputStyle} />
      </div>

      <div style={{ marginBottom: meta.supportsBaseUrl ? 14 : 18 }}>
        <FieldLabel>API key *</FieldLabel>
        <div style={{ position: 'relative' }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
            placeholder={meta.keyHint}
            autoComplete="off"
            spellCheck={false}
            style={{ ...inputStyle, fontFamily: MONO, paddingRight: 38 }}
          />
          <button type="button" onClick={() => setShowKey(s => !s)} title={showKey ? 'Hide' : 'Show'}
            style={{
              position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer',
              color: C.textMuted, display: 'flex', padding: 6, borderRadius: 4,
            }}>
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>
          Stored encrypted (AES-256-GCM). It never leaves your server in plaintext.
        </div>
      </div>

      {/* Only offered where it's meaningful. A native provider (Anthropic) uses
          its own SDK and must never be pointed elsewhere. */}
      {meta.supportsBaseUrl && (
        <div style={{ marginBottom: 18 }}>
          <FieldLabel>Custom base URL (optional)</FieldLabel>
          <input
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder={meta.defaultBaseUrl || 'https://openrouter.ai/api/v1'}
            autoComplete="off"
            spellCheck={false}
            style={{ ...inputStyle, fontFamily: MONO }}
          />
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6, lineHeight: 1.5 }}>
            <Link2 size={11} style={{ verticalAlign: '-1px' }} /> For a gateway (OpenRouter, an internal proxy).
            Leave blank to use {meta.defaultBaseUrl ? <code style={{ fontFamily: MONO }}>{meta.defaultBaseUrl}</code> : `${meta.label}'s own endpoint`}.
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onCancel} style={ghostBtn(false)}>Cancel</button>
        <button onClick={handleSave} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.7 : 1 }}>
          {saving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <KeyRound size={13} />}
          Save key
        </button>
      </div>
    </div>
  );
}

function ModelRow({ model, meta, onDelete }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '14px 16px', background: C.cardBg, borderRadius: 10,
      border: `1px solid ${C.border}`, gap: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 9, background: C.primaryLight,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Bot size={17} color={C.primary} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
            {model.label || (meta ? meta.label : model.provider)}
          </div>
          <div style={{ fontSize: 11, color: C.textMuted, fontFamily: MONO, marginTop: 3 }}>
            {model.apiKeyMasked || '••••••••'}
          </div>
          {/* A gateway override changes where this key is sent. Showing it beats
              discovering it in a failed agent run. */}
          {model.baseUrl && (
            <div title={model.baseUrl} style={{
              fontSize: 10.5, color: C.textSecondary, fontFamily: MONO, marginTop: 4,
              display: 'flex', alignItems: 'center', gap: 4,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 340,
            }}>
              <Link2 size={10} style={{ flexShrink: 0 }} /> {model.baseUrl}
            </div>
          )}
        </div>
      </div>
      <button onClick={onDelete} title="Remove"
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '7px 10px', borderRadius: 8,
          border: `1px solid ${C.border}`, background: C.cardBg,
          color: C.primary, fontSize: 12, fontFamily: FONT, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
        }}>
        <Trash2 size={13} /> Remove
      </button>
    </div>
  );
}

function EmptyState({ meta, onAdd }) {
  return (
    <div style={{
      padding: 28, borderRadius: 12, background: 'var(--c-surfaceAlt)',
      border: `1px dashed ${C.border}`, textAlign: 'center',
    }}>
      <div style={{
        width: 46, height: 46, borderRadius: 12, margin: '0 auto 12px', background: C.primaryLight,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Bot size={22} color={C.primary} />
      </div>
      <div style={{ fontSize: 14.5, fontWeight: 700, color: C.text, marginBottom: 6 }}>
        No {meta.label} key connected
      </div>
      <p style={{ fontSize: 12.5, color: C.textSecondary, margin: '0 0 16px', lineHeight: 1.55 }}>
        Add one so your AI Agents can run on {meta.label}.
      </p>
      <button onClick={onAdd} style={{ ...primaryBtn, margin: '0 auto' }}>
        <Plus size={14} /> Add key
      </button>
    </div>
  );
}

function FieldLabel({ children }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: C.textSecondary,
      textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6,
    }}>{children}</div>
  );
}

const inputStyle = {
  width: '100%', padding: '10px 12px', borderRadius: 8,
  border: `1px solid ${C.border}`, fontSize: 14, fontFamily: FONT,
  color: C.text, background: C.cardBg, outline: 'none', boxSizing: 'border-box',
};

const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '9px 14px', borderRadius: 8, border: 'none',
  background: C.primary, color: '#fff', fontSize: 13, fontFamily: FONT, fontWeight: 700, cursor: 'pointer',
};

const ghostBtn = (busy) => ({
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '9px 12px', borderRadius: 8, border: `1px solid ${C.border}`,
  background: C.cardBg, color: C.text, fontSize: 12, fontFamily: FONT, fontWeight: 600,
  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
});

function prettyError(e) {
  if (!e) return 'Unknown error';
  const msg = e.message || String(e);
  try {
    const m = msg.match(/^\d+\s+(.+)$/);
    if (m) {
      const body = JSON.parse(m[1]);
      if (body && body.error) return body.error;
    }
  } catch { /* not JSON — fall through */ }
  return msg;
}
