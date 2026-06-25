// Super Admin console (SaaS Phase 3 UI).
//
// Platform-owner surface, reachable at #/super-admin and only shown to users
// whose session has isSuperAdmin === true. Talks to /api/platform/*. Tabs:
// Overview (stats), Tenants (list/create/suspend/activate/change plan), Plans,
// Audit. Kept self-contained with inline styles to match the app's look.

import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'tenants', label: 'Tenants' },
  { key: 'plans', label: 'Plans' },
  { key: 'audit', label: 'Audit Log' },
];

const card = {
  background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 12,
  padding: 18, boxShadow: C.shadowSm,
};
const btn = {
  padding: '8px 14px', borderRadius: 8, border: `1px solid ${C.border}`,
  background: C.cardBg, color: C.text, fontFamily: FONT, fontSize: 13,
  fontWeight: 600, cursor: 'pointer',
};
const btnPrimary = { ...btn, background: C.primary, color: '#fff', border: 'none' };

function StatusPill({ status }) {
  const map = {
    active: C.green, trial: C.amber, suspended: '#DC2626', cancelled: C.textMuted,
  };
  const color = map[status] || C.textMuted;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, color, background: `${color}1a`,
      padding: '3px 9px', borderRadius: 20, textTransform: 'capitalize',
    }}>{status}</span>
  );
}

export default function SuperAdminPage() {
  const [tab, setTab] = useState('overview');

  return (
    <div style={{ padding: '28px 32px', fontFamily: FONT, color: C.text, maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.primary }}>
        Platform
      </div>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: '0 0 20px', letterSpacing: '-0.02em' }}>Super Admin</h1>

      <div style={{ display: 'flex', gap: 6, marginBottom: 22, borderBottom: `1px solid ${C.border}` }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer',
            fontFamily: FONT, fontSize: 14, fontWeight: 600,
            color: tab === t.key ? C.primary : C.textSecondary,
            borderBottom: tab === t.key ? `2px solid ${C.primary}` : '2px solid transparent',
            marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && <Overview />}
      {tab === 'tenants' && <Tenants />}
      {tab === 'plans' && <Plans />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function useAsync(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(() => {
    setLoading(true); setError(null);
    fn().then(setData).catch(e => setError(e.message)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { data, error, loading, reload: run };
}

function Overview() {
  const { data, error, loading } = useAsync(() => api.platform.stats(), []);
  if (loading) return <Muted>Loading…</Muted>;
  if (error) return <ErrorBox msg={error} />;
  const items = [
    ['Tenants', data.tenants], ['Active', data.active_tenants], ['Suspended', data.suspended_tenants],
    ['Organizations', data.organizations], ['Users', data.users], ['Live subscriptions', data.live_subscriptions],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14 }}>
      {items.map(([label, val]) => (
        <div key={label} style={card}>
          <div style={{ fontSize: 13, color: C.textSecondary, fontWeight: 600 }}>{label}</div>
          <div style={{ fontSize: 30, fontWeight: 800, marginTop: 6 }}>{val ?? 0}</div>
        </div>
      ))}
    </div>
  );
}

function Tenants() {
  const { data, error, loading, reload } = useAsync(() => api.platform.tenants(), []);
  const { data: plans } = useAsync(() => api.platform.plans(), []);
  const [showCreate, setShowCreate] = useState(false);
  const [usersFor, setUsersFor] = useState(null); // tenant whose users are shown (impersonation)
  const [busy, setBusy] = useState(null);

  const planKeys = (plans || []).map(p => p.key);

  async function toggleStatus(t) {
    const next = t.status === 'suspended' ? 'active' : 'suspended';
    if (!window.confirm(`${next === 'suspended' ? 'Suspend' : 'Activate'} tenant "${t.name}"?`)) return;
    setBusy(t.id);
    try { await api.platform.updateTenant(t.id, { status: next }); reload(); }
    catch (e) { alert(e.message); } finally { setBusy(null); }
  }

  async function changePlan(t, planKey) {
    if (!planKey || planKey === t.plan_key) return;
    setBusy(t.id);
    try { await api.platform.setSubscription(t.id, { planKey }); reload(); }
    catch (e) { alert(e.message); } finally { setBusy(null); }
  }

  if (loading) return <Muted>Loading…</Muted>;
  if (error) return <ErrorBox msg={error} />;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button style={btnPrimary} onClick={() => setShowCreate(true)}>+ New tenant</button>
      </div>
      {showCreate && (
        <CreateTenant planKeys={planKeys} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); reload(); }} />
      )}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead>
            <tr style={{ background: C.pageBg, textAlign: 'left', color: C.textSecondary }}>
              {['Tenant', 'Slug', 'Status', 'Plan', 'Orgs', 'Users', ''].map(h => (
                <th key={h} style={{ padding: '11px 14px', fontWeight: 600, fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data || []).map(t => (
              <tr key={t.id} style={{ borderTop: `1px solid ${C.border}` }}>
                <td style={{ padding: '11px 14px', fontWeight: 600 }}>{t.name}</td>
                <td style={{ padding: '11px 14px', color: C.textSecondary }}>{t.slug}</td>
                <td style={{ padding: '11px 14px' }}><StatusPill status={t.status} /></td>
                <td style={{ padding: '11px 14px' }}>
                  <select value={t.plan_key || ''} disabled={busy === t.id}
                    onChange={e => changePlan(t, e.target.value)}
                    style={{ ...btn, padding: '5px 8px', fontSize: 12.5 }}>
                    {!t.plan_key && <option value="">—</option>}
                    {(plans || []).map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                  </select>
                </td>
                <td style={{ padding: '11px 14px' }}>{t.organizations}</td>
                <td style={{ padding: '11px 14px' }}>{t.users}</td>
                <td style={{ padding: '11px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button style={{ ...btn, padding: '5px 10px', fontSize: 12.5, marginRight: 6 }} disabled={busy === t.id}
                    onClick={() => setUsersFor(t)}>
                    Impersonate
                  </button>
                  <button style={{ ...btn, padding: '5px 10px', fontSize: 12.5 }} disabled={busy === t.id}
                    onClick={() => toggleStatus(t)}>
                    {t.status === 'suspended' ? 'Activate' : 'Suspend'}
                  </button>
                </td>
              </tr>
            ))}
            {(data || []).length === 0 && (
              <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: C.textMuted }}>No tenants yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {usersFor && <ImpersonateModal tenant={usersFor} onClose={() => setUsersFor(null)} />}
    </div>
  );
}

function ImpersonateModal({ tenant, onClose }) {
  const { data: users, error, loading } = useAsync(() => api.platform.tenantUsers(tenant.id), [tenant.id]);
  const [busy, setBusy] = useState(false);

  async function impersonate(u) {
    const reason = window.prompt(`Reason for impersonating ${u.display_name || u.username}? (required, audited)`);
    if (reason == null) return;
    if (!reason.trim()) { alert('A reason is required.'); return; }
    setBusy(true);
    try {
      await api.platform.impersonate(u.id, reason.trim());
      // The session cookie is now the impersonated user — reload to enter it.
      window.location.hash = '#/home';
      window.location.reload();
    } catch (e) { alert(e.message); setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500, padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 520, maxHeight: '80vh', overflow: 'auto',
        background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 18, boxShadow: C.shadowLg,
        animation: 'scaleInFast 0.18s cubic-bezier(0.16,1,0.3,1) both',
      }}>
        <div style={{ padding: '18px 20px', borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Impersonate a user</div>
          <div style={{ fontSize: 12.5, color: C.textSecondary, marginTop: 2 }}>{tenant.name} · time-limited & fully audited</div>
        </div>
        <div style={{ padding: 12 }}>
          {loading ? <Muted>Loading users…</Muted> : error ? <ErrorBox msg={error} /> : (users || []).length === 0 ? (
            <Muted>No users in this tenant.</Muted>
          ) : (users || []).map(u => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 11 }}>
              <span style={{ width: 34, height: 34, borderRadius: 9, background: `${C.primary}1f`, color: C.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0 }}>
                {(u.display_name || u.username || '?').charAt(0).toUpperCase()}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{u.display_name || u.username}</div>
                <div style={{ fontSize: 11.5, color: C.textMuted }}>{u.email} · {u.role}{u.is_active === false ? ' · disabled' : ''}</div>
              </div>
              <button style={{ ...btnPrimary, padding: '6px 12px', fontSize: 12.5 }} disabled={busy || u.is_active === false}
                onClick={() => impersonate(u)}>
                Impersonate
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CreateTenant({ planKeys, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [planKey, setPlanKey] = useState(planKeys[0] || 'starter');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit() {
    if (!name.trim()) { setErr('Name is required'); return; }
    setBusy(true); setErr(null);
    try { await api.platform.createTenant({ name: name.trim(), planKey }); onCreated(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={{ fontWeight: 700, marginBottom: 12 }}>Create tenant</div>
      {err && <ErrorBox msg={err} />}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input autoFocus placeholder="Company name" value={name} onChange={e => setName(e.target.value)}
          style={{ flex: 1, minWidth: 200, padding: '9px 11px', borderRadius: 8, border: `1px solid ${C.border}`, fontFamily: FONT, fontSize: 14 }} />
        <select value={planKey} onChange={e => setPlanKey(e.target.value)} style={{ ...btn }}>
          {planKeys.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
        <button style={btnPrimary} onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>
      </div>
    </div>
  );
}

function Plans() {
  const { data, error, loading } = useAsync(() => api.platform.plans(), []);
  if (loading) return <Muted>Loading…</Muted>;
  if (error) return <ErrorBox msg={error} />;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
      {(data || []).map(p => (
        <div key={p.key} style={card}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>{p.name}</div>
          <div style={{ fontSize: 22, fontWeight: 800, margin: '6px 0' }}>
            {Number(p.price_monthly) === 0 ? 'Custom' : `$${p.price_monthly}`}<span style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>/mo</span>
          </div>
          <div style={{ fontSize: 12.5, color: C.textSecondary, marginBottom: 10 }}>{p.description}</div>
          <div style={{ fontSize: 12, color: C.textSecondary, lineHeight: 1.8 }}>
            <div>Users: {p.max_users ?? '∞'}</div>
            <div>Orgs: {p.max_organizations ?? '∞'}</div>
            <div>Contacts: {p.max_contacts ?? '∞'}</div>
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {(p.features || []).map(f => (
              <span key={f} style={{ fontSize: 10.5, fontWeight: 600, color: C.primary, background: `${C.primary}14`, padding: '2px 7px', borderRadius: 6 }}>{f}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Audit() {
  const { data, error, loading } = useAsync(() => api.platform.audit(150), []);
  if (loading) return <Muted>Loading…</Muted>;
  if (error) return <ErrorBox msg={error} />;
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: C.pageBg, textAlign: 'left', color: C.textSecondary }}>
            {['When', 'Actor', 'Action', 'Target', 'Tenant'].map(h => (
              <th key={h} style={{ padding: '10px 14px', fontWeight: 600, fontSize: 12 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(data || []).map(r => (
            <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={{ padding: '9px 14px', color: C.textSecondary, whiteSpace: 'nowrap' }}>{new Date(r.created_at).toLocaleString()}</td>
              <td style={{ padding: '9px 14px' }}>{r.actor_username || r.actor_user_id || '—'}</td>
              <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12 }}>{r.action}</td>
              <td style={{ padding: '9px 14px', color: C.textSecondary }}>{r.target_type ? `${r.target_type}#${r.target_id}` : '—'}</td>
              <td style={{ padding: '9px 14px', color: C.textSecondary }}>{r.tenant_id ?? '—'}</td>
            </tr>
          ))}
          {(data || []).length === 0 && (
            <tr><td colSpan={5} style={{ padding: 20, textAlign: 'center', color: C.textMuted }}>No audit entries.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Muted({ children }) {
  return <div style={{ color: C.textMuted, fontSize: 14, padding: 20 }}>{children}</div>;
}
function ErrorBox({ msg }) {
  return (
    <div style={{ color: '#DC2626', background: '#DC26261a', border: '1px solid #DC262633', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>
      {msg}
    </div>
  );
}
