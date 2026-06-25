// Organizations management (SaaS Phase 5). Tenant admins create / rename /
// suspend / delete the organizations inside their tenant. Each org is an
// isolated workspace (own WhatsApp account, contacts, deals, …).

import { useState, useEffect, useCallback } from 'react';
import { Building2, Plus, Users, Trash2, Power, Pencil, X, Check } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

const btn = {
  padding: '8px 14px', borderRadius: 9, border: `1px solid ${C.border}`,
  background: C.cardBg, color: C.text, fontFamily: FONT, fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
const btnPrimary = {
  ...btn, border: 'none', color: '#fff',
  background: `linear-gradient(135deg, ${C.primary}, ${C.primaryHover})`,
  boxShadow: `0 10px 24px ${C.primary}33`,
};

export default function OrganizationsPage({ onOrgsChanged, activeOrg }) {
  const [orgs, setOrgs] = useState(null);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null); // id being renamed
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    api.organizations.list()
      .then(rows => { setOrgs(rows); setError(null); })
      .catch(e => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const afterChange = () => { load(); onOrgsChanged?.(); };

  async function rename(o, name) {
    if (!name.trim() || name === o.name) { setEditing(null); return; }
    setBusy(o.id);
    try { await api.organizations.update(o.id, { name: name.trim() }); setEditing(null); afterChange(); }
    catch (e) { alert(e.message); } finally { setBusy(null); }
  }
  async function toggle(o) {
    const status = o.status === 'suspended' ? 'active' : 'suspended';
    setBusy(o.id);
    try { await api.organizations.update(o.id, { status }); afterChange(); }
    catch (e) { alert(e.message); } finally { setBusy(null); }
  }
  async function remove(o) {
    if (!window.confirm(`Delete "${o.name}"? Its data stays but the workspace is removed.`)) return;
    setBusy(o.id);
    try { await api.organizations.remove(o.id); afterChange(); }
    catch (e) { alert(e.message); } finally { setBusy(null); }
  }

  return (
    <div style={{ padding: '28px 32px 48px', fontFamily: FONT, color: C.text, maxWidth: 1000, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 22 }}>
        <div>
          <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.primary }}>Workspace</div>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: '0 0 4px', letterSpacing: '-0.02em' }}>Organizations</h1>
          <p style={{ fontSize: 13.5, color: C.textSecondary, margin: 0, maxWidth: 540, lineHeight: 1.5 }}>
            Each organization is an isolated workspace with its own WhatsApp number, contacts, deals and team.
          </p>
        </div>
        <button style={btnPrimary} onClick={() => setShowCreate(true)}><Plus size={15} style={{ verticalAlign: '-2px', marginRight: 4 }} />New organization</button>
      </div>

      {error && <ErrorBox msg={error} />}
      {showCreate && <CreateOrg onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); afterChange(); }} />}

      {orgs == null ? (
        <Muted>Loading…</Muted>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
          {orgs.map(o => {
            const isActiveView = String(activeOrg) === String(o.id);
            const suspended = o.status === 'suspended';
            return (
              <div key={o.id} style={{
                background: C.cardBg, border: `1.5px solid ${isActiveView ? C.primary : C.border}`, borderRadius: 16,
                padding: 18, boxShadow: C.shadowSm, opacity: suspended ? 0.7 : 1, position: 'relative',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                  <span style={{ width: 40, height: 40, borderRadius: 11, background: `${C.primary}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Building2 size={20} color={C.primary} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editing === o.id ? (
                      <InlineRename initial={o.name} busy={busy === o.id} onCancel={() => setEditing(null)} onSave={(v) => rename(o, v)} />
                    ) : (
                      <>
                        <div style={{ fontSize: 15.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</div>
                        <div style={{ fontSize: 11.5, color: C.textMuted, fontFamily: FONT }}>{o.slug}</div>
                      </>
                    )}
                  </div>
                  {isActiveView && (
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: C.primary, background: C.primaryLight, padding: '3px 8px', borderRadius: 20 }}>Viewing</span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12.5, color: C.textSecondary, marginBottom: 14 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Users size={13} /> {o.members ?? 0}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: suspended ? '#DC2626' : C.green }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: suspended ? '#DC2626' : C.green }} />
                    {suspended ? 'Suspended' : 'Active'}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: 6, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                  <IconBtn title="Rename" onClick={() => setEditing(o.id)} disabled={busy === o.id}><Pencil size={14} /></IconBtn>
                  <IconBtn title={suspended ? 'Activate' : 'Suspend'} onClick={() => toggle(o)} disabled={busy === o.id}><Power size={14} /></IconBtn>
                  <div style={{ flex: 1 }} />
                  <IconBtn title="Delete" danger onClick={() => remove(o)} disabled={busy === o.id}><Trash2 size={14} /></IconBtn>
                </div>
              </div>
            );
          })}
          {orgs.length === 0 && <Muted>No organizations yet.</Muted>}
        </div>
      )}
    </div>
  );
}

function CreateOrg({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function submit() {
    if (!name.trim()) { setErr('Name is required'); return; }
    setBusy(true); setErr(null);
    try { await api.organizations.create({ name: name.trim() }); onCreated(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18, marginBottom: 16, boxShadow: C.shadowSm }}>
      <div style={{ fontWeight: 700, marginBottom: 12 }}>Create organization</div>
      {err && <ErrorBox msg={err} />}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input autoFocus placeholder="e.g. ABC Real Estate" value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          style={{ flex: 1, minWidth: 220, padding: '10px 12px', borderRadius: 9, border: `1px solid ${C.border}`, background: C.surfaceAlt, color: C.text, fontFamily: FONT, fontSize: 14 }} />
        <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
        <button style={btnPrimary} onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
      </div>
    </div>
  );
}

function InlineRename({ initial, busy, onSave, onCancel }) {
  const [v, setV] = useState(initial);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input autoFocus value={v} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onSave(v); if (e.key === 'Escape') onCancel(); }}
        style={{ flex: 1, minWidth: 0, padding: '6px 9px', borderRadius: 7, border: `1px solid ${C.primary}`, background: C.surfaceAlt, color: C.text, fontFamily: FONT, fontSize: 14, fontWeight: 600 }} />
      <IconBtn title="Save" onClick={() => onSave(v)} disabled={busy}><Check size={14} /></IconBtn>
      <IconBtn title="Cancel" onClick={onCancel}><X size={14} /></IconBtn>
    </div>
  );
}

function IconBtn({ children, onClick, title, danger, disabled }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled} style={{
      width: 32, height: 30, borderRadius: 8, cursor: disabled ? 'default' : 'pointer',
      background: 'transparent', border: `1px solid ${C.border}`,
      color: danger ? '#DC2626' : C.textSecondary, display: 'flex', alignItems: 'center', justifyContent: 'center',
      opacity: disabled ? 0.5 : 1, transition: 'background .12s, border-color .12s',
    }}
      onMouseEnter={e => { if (!disabled) { e.currentTarget.style.background = danger ? '#DC26261a' : 'rgba(0,0,0,.06)'; e.currentTarget.style.borderColor = danger ? '#DC262644' : C.borderDark; } }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = C.border; }}
    >{children}</button>
  );
}

function Muted({ children }) { return <div style={{ color: C.textMuted, fontSize: 14, padding: 20 }}>{children}</div>; }
function ErrorBox({ msg }) {
  return <div style={{ color: '#DC2626', background: '#DC26261a', border: '1px solid #DC262633', borderRadius: 9, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>{msg}</div>;
}
