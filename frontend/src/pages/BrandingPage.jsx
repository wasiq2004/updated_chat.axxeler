// White-label studio (SaaS Phase 6). Tenant admins set a brand name, accent
// color and logo. Renders only when the white_label feature is in the plan (the
// App-level gate shows an UpgradeGate otherwise). Includes a live preview.

import { useState, useEffect } from 'react';
import { Palette, Check, RotateCcw, MessageCircle, Megaphone, Users } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

const SWATCHES = ['#0FA8E0', '#F6B100', '#2563EB', '#7C3AED', '#059669', '#EA580C', '#0891B2', '#DB2777'];

export default function BrandingPage({ onSaved, managedByReseller }) {
  const [form, setForm] = useState({ brandName: '', primaryColor: '', logoUrl: '' });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.branding.get()
      .then(b => setForm({ brandName: b.brandName || '', primaryColor: b.primaryColor || '', logoUrl: b.logoUrl || '' }))
      .catch(e => setError(e.message))
      .finally(() => setLoaded(true));
  }, []);

  const accent = /^#[0-9a-fA-F]{6}$/.test(form.primaryColor) ? form.primaryColor : '#0FA8E0';
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setSaved(false); };

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.branding.update({
        brandName: form.brandName.trim() || null,
        primaryColor: form.primaryColor || null,
        logoUrl: form.logoUrl.trim() || null,
      });
      setSaved(true);
      onSaved?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function reset() {
    setForm({ brandName: '', primaryColor: '', logoUrl: '' });
    setBusy(true); setError(null);
    try { await api.branding.update({ brandName: null, primaryColor: null, logoUrl: null }); setSaved(true); onSaved?.(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (!loaded) return <div style={{ padding: 40, fontFamily: FONT, color: C.textMuted }}>Loading…</div>;

  return (
    <div style={{ padding: '28px 32px 48px', fontFamily: FONT, color: C.text, maxWidth: 1040, margin: '0 auto', width: '100%' }}>
      <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: accent }}>White label</div>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: '0 0 4px', letterSpacing: '-0.02em' }}>Branding</h1>
      <p style={{ fontSize: 13.5, color: C.textSecondary, margin: '0 0 24px', maxWidth: 560, lineHeight: 1.5 }}>
        Make the platform yours. Changes apply across the workspace for everyone on your team.
      </p>

      {managedByReseller && (
        <div style={{ color: C.text, background: `${C.amber}1a`, border: `1px solid ${C.amber}55`, borderRadius: 9, padding: '11px 13px', fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
          Your workspace is provided by a partner, so branding is managed by them and shown across the app. Any changes you save here won’t be visible to your users.
        </div>
      )}

      {error && <div style={{ color: '#DC2626', background: '#DC26261a', border: '1px solid #DC262633', borderRadius: 9, padding: '10px 12px', fontSize: 13, marginBottom: 16 }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) minmax(280px, 360px)', gap: 22, alignItems: 'start' }}>
        {/* Controls */}
        <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 16, padding: 22, boxShadow: C.shadowSm }}>
          <Field label="Brand name" hint="Shown in place of “Zen Chat”.">
            <input value={form.brandName} maxLength={60} onChange={e => set('brandName', e.target.value)}
              placeholder="Acme Messaging" style={inp} />
          </Field>

          <Field label="Accent color" hint="Buttons, highlights and links.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <input type="color" value={accent} onChange={e => set('primaryColor', e.target.value)}
                style={{ width: 42, height: 38, borderRadius: 9, border: `1px solid ${C.border}`, background: 'none', cursor: 'pointer', padding: 2 }} />
              <input value={form.primaryColor} onChange={e => set('primaryColor', e.target.value)}
                placeholder="#0FA8E0" style={{ ...inp, width: 120, fontFamily: 'monospace' }} />
              <div style={{ display: 'flex', gap: 6 }}>
                {SWATCHES.map(s => (
                  <button key={s} onClick={() => set('primaryColor', s)} title={s} style={{
                    width: 22, height: 22, borderRadius: 6, background: s, cursor: 'pointer',
                    border: form.primaryColor?.toLowerCase() === s.toLowerCase() ? `2px solid ${C.text}` : `1px solid ${C.border}`,
                  }} />
                ))}
              </div>
            </div>
          </Field>

          <Field label="Logo URL" hint="A wide/transparent PNG works best.">
            <input value={form.logoUrl} onChange={e => set('logoUrl', e.target.value)}
              placeholder="https://…/logo.png" style={inp} />
          </Field>

          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button onClick={save} disabled={busy} style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 10, border: 'none',
              background: `linear-gradient(135deg, ${accent}, ${accent})`, color: '#fff', fontFamily: FONT, fontSize: 14, fontWeight: 700,
              cursor: busy ? 'default' : 'pointer', boxShadow: `0 10px 24px ${accent}40`,
            }}>
              {saved ? <Check size={16} /> : <Palette size={16} />}{busy ? 'Saving…' : saved ? 'Saved' : 'Save branding'}
            </button>
            <button onClick={reset} disabled={busy} style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 16px', borderRadius: 10,
              border: `1px solid ${C.border}`, background: C.cardBg, color: C.textSecondary, fontFamily: FONT, fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>
              <RotateCcw size={15} /> Reset
            </button>
          </div>
        </div>

        {/* Live preview */}
        <div>
          <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 10 }}>Live preview</div>
          <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 16, overflow: 'hidden', boxShadow: C.shadowSm }}>
            {/* fake topbar */}
            <div style={{ height: 48, display: 'flex', alignItems: 'center', padding: '0 14px', gap: 10, borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt }}>
              {form.logoUrl
                ? <img src={form.logoUrl} alt="" style={{ height: 22, maxWidth: 120, objectFit: 'contain' }} onError={e => { e.currentTarget.style.display = 'none'; }} />
                : <span style={{ fontSize: 15, fontWeight: 800, color: accent }}>{form.brandName || 'Zen Chat'}</span>}
              <div style={{ flex: 1 }} />
              <span style={{ width: 26, height: 26, borderRadius: 7, background: `linear-gradient(135deg, ${accent}, ${accent})`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 700 }}>A</span>
            </div>
            <div style={{ padding: 16 }}>
              {[{ Icon: MessageCircle, label: 'Chats', on: true }, { Icon: Users, label: 'Contacts' }, { Icon: Megaphone, label: 'Campaigns' }].map(({ Icon, label, on }) => (
                <div key={label} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 10, marginBottom: 4, fontSize: 13, fontWeight: 600,
                  background: on ? `linear-gradient(135deg, ${accent}, ${accent}dd)` : 'transparent', color: on ? '#fff' : C.textSecondary,
                }}>
                  <Icon size={15} /> {label}
                </div>
              ))}
              <button style={{ marginTop: 12, width: '100%', padding: '10px', borderRadius: 10, border: 'none', background: accent, color: '#fff', fontFamily: FONT, fontSize: 13.5, fontWeight: 700, cursor: 'default' }}>
                Send broadcast
              </button>
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 10, lineHeight: 1.5 }}>
            The accent color applies instantly across the real app after you save.
          </div>
        </div>
      </div>
    </div>
  );
}

const inp = {
  width: '100%', padding: '10px 12px', borderRadius: 9, border: `1px solid ${C.border}`,
  background: C.surfaceAlt, color: C.text, fontFamily: FONT, fontSize: 14, boxSizing: 'border-box',
};

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{label}</div>
      {hint && <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 8 }}>{hint}</div>}
      {children}
    </div>
  );
}
