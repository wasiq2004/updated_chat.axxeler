// Super Admin console (SaaS platform-owner surface).
//
// Reachable at #/super-admin, only for sessions with isSuperAdmin === true.
// Talks to /api/platform/*. Tabs:
//   Overview — platform analytics (tenants, users, MRR, plan mix, expiring soon)
//   Admins   — create an admin (provisions their login), drill into their
//              organizations + users, edit credentials, renew/change plan,
//              suspend/activate, and impersonate.
//   Plans    — plan catalog
//   Audit    — platform audit log
// Self-contained inline styles to match the app's look.

import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'admins', label: 'Admins' },
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
const inputStyle = {
  padding: '9px 11px', borderRadius: 8, border: `1px solid ${C.border}`,
  fontFamily: FONT, fontSize: 14, background: C.cardBg, color: C.text,
};

function fmtMoney(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: v < 100 ? 2 : 0 })}`;
}
function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

function StatusPill({ status }) {
  const map = {
    active: C.green, trial: C.amber, trialing: C.amber, past_due: C.amber,
    suspended: '#DC2626', cancelled: C.textMuted,
  };
  const color = map[status] || C.textMuted;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, color, background: `${color}1a`,
      padding: '3px 9px', borderRadius: 20, textTransform: 'capitalize',
    }}>{String(status || '—').replace('_', ' ')}</span>
  );
}

export default function SuperAdminPage() {
  const [tab, setTab] = useState('overview');

  return (
    <div style={{ padding: '28px 32px', fontFamily: FONT, color: C.text, maxWidth: 1180, margin: '0 auto', width: '100%' }}>
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
      {tab === 'admins' && <Admins />}
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

// ─── Overview / analytics ────────────────────────────────────────────────────
function Overview() {
  const { data, error, loading } = useAsync(() => api.platform.stats(), []);
  if (loading) return <Muted>Loading…</Muted>;
  if (error) return <ErrorBox msg={error} />;

  const tiles = [
    ['Monthly revenue', fmtMoney(data.mrr), C.green],
    ['Admins (tenants)', data.tenants, C.text],
    ['Active', data.active_tenants, C.green],
    ['Suspended', data.suspended_tenants, '#DC2626'],
    ['New this month', data.new_tenants_this_month, C.primary],
    ['Organizations', data.organizations, C.text],
    ['Users', data.users, C.text],
    ['Live subscriptions', data.live_subscriptions, C.text],
    ['Expiring ≤7 days', data.expiring_soon, C.amber],
  ];
  const dist = data.plan_distribution || [];
  const maxCount = Math.max(1, ...dist.map(d => d.tenants));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14 }}>
        {tiles.map(([label, val, color]) => (
          <div key={label} style={card}>
            <div style={{ fontSize: 12.5, color: C.textSecondary, fontWeight: 600 }}>{label}</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6, color }}>{val ?? 0}</div>
          </div>
        ))}
      </div>

      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Subscriptions by plan</div>
        {dist.length === 0 ? <Muted>No live subscriptions yet.</Muted> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {dist.map(d => (
              <div key={d.plan_key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 110, fontSize: 13, fontWeight: 600 }}>{d.plan_name}</div>
                <div style={{ flex: 1, height: 22, background: C.pageBg, borderRadius: 6, overflow: 'hidden' }}>
                  <div style={{
                    width: `${(d.tenants / maxCount) * 100}%`, height: '100%',
                    background: C.primary, borderRadius: 6, transition: 'width .4s',
                  }} />
                </div>
                <div style={{ width: 120, textAlign: 'right', fontSize: 12.5, color: C.textSecondary }}>
                  {d.tenants} · {fmtMoney(d.price_monthly)}/mo
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Admins (tenants) ────────────────────────────────────────────────────────
function Admins() {
  const { data, error, loading, reload } = useAsync(() => api.platform.tenants(), []);
  const { data: plans } = useAsync(() => api.platform.plans(), []);
  const [showCreate, setShowCreate] = useState(false);
  const [detailFor, setDetailFor] = useState(null); // tenant id open in the drill-down

  if (loading) return <Muted>Loading…</Muted>;
  if (error) return <ErrorBox msg={error} />;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: C.textSecondary }}>
          Each admin is a workspace with its own login, organizations and users.
        </div>
        <button style={btnPrimary} onClick={() => setShowCreate(true)}>+ New admin</button>
      </div>
      {showCreate && (
        <CreateAdmin plans={plans || []} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); reload(); }} />
      )}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead>
            <tr style={{ background: C.pageBg, textAlign: 'left', color: C.textSecondary }}>
              {['Admin', 'Slug', 'Status', 'Plan', 'Orgs', 'Users', ''].map(h => (
                <th key={h} style={{ padding: '11px 14px', fontWeight: 600, fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data || []).map(t => (
              <tr key={t.id} style={{ borderTop: `1px solid ${C.border}`, cursor: 'pointer' }}
                onClick={() => setDetailFor(t.id)}>
                <td style={{ padding: '11px 14px', fontWeight: 600 }}>{t.name}</td>
                <td style={{ padding: '11px 14px', color: C.textSecondary }}>{t.slug}</td>
                <td style={{ padding: '11px 14px' }}><StatusPill status={t.status} /></td>
                <td style={{ padding: '11px 14px' }}>{t.plan_name || '—'}</td>
                <td style={{ padding: '11px 14px' }}>{t.organizations}</td>
                <td style={{ padding: '11px 14px' }}>{t.users}</td>
                <td style={{ padding: '11px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button style={{ ...btn, padding: '5px 10px', fontSize: 12.5 }}
                    onClick={(e) => { e.stopPropagation(); setDetailFor(t.id); }}>
                    Manage →
                  </button>
                </td>
              </tr>
            ))}
            {(data || []).length === 0 && (
              <tr><td colSpan={7} style={{ padding: 20, textAlign: 'center', color: C.textMuted }}>No admins yet. Create one to get started.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {detailFor && (
        <AdminDetail tenantId={detailFor} plans={plans || []} onClose={() => setDetailFor(null)} onChanged={reload} />
      )}
    </div>
  );
}

function CreateAdmin({ plans, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [planKey, setPlanKey] = useState(plans[0]?.key || 'starter');
  const [billingCycle, setBillingCycle] = useState('monthly');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [created, setCreated] = useState(null); // { admin, generatedPassword }

  async function submit() {
    if (!name.trim()) { setErr('Workspace name is required'); return; }
    if (!adminEmail.trim()) { setErr('Admin email is required'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.platform.createTenant({
        name: name.trim(), planKey, billingCycle,
        adminEmail: adminEmail.trim(), adminName: adminName.trim() || undefined,
        adminPassword: adminPassword.trim() || undefined,
      });
      setCreated({ email: adminEmail.trim(), password: r.generatedPassword || adminPassword.trim() });
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  if (created) {
    return (
      <div style={{ ...card, marginBottom: 14, borderColor: C.green }}>
        <div style={{ fontWeight: 700, marginBottom: 8, color: C.green }}>✓ Admin created</div>
        <div style={{ fontSize: 13, color: C.textSecondary, marginBottom: 10 }}>
          Hand these credentials to the admin. The password is shown once.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, fontFamily: 'monospace', background: C.pageBg, padding: 12, borderRadius: 8 }}>
          <div>Email: <b>{created.email}</b></div>
          <div>Password: <b>{created.password}</b></div>
        </div>
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <button style={btnPrimary} onClick={onCreated}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={{ fontWeight: 700, marginBottom: 12 }}>Create admin</div>
      {err && <ErrorBox msg={err} />}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <input autoFocus placeholder="Workspace / company name" value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        <input placeholder="Admin email (login)" value={adminEmail} onChange={e => setAdminEmail(e.target.value)} style={inputStyle} />
        <input placeholder="Admin display name (optional)" value={adminName} onChange={e => setAdminName(e.target.value)} style={inputStyle} />
        <input placeholder="Password (blank = auto-generate)" value={adminPassword} onChange={e => setAdminPassword(e.target.value)} style={inputStyle} />
        <select value={planKey} onChange={e => setPlanKey(e.target.value)} style={inputStyle}>
          {plans.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
        </select>
        <select value={billingCycle} onChange={e => setBillingCycle(e.target.value)} style={inputStyle}>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </select>
      </div>
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
        <button style={btnPrimary} onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create admin'}</button>
      </div>
    </div>
  );
}

// ─── Admin drill-down: subscription, admin login, orgs → users ───────────────
function AdminDetail({ tenantId, plans, onClose, onChanged }) {
  const { data, error, loading, reload } = useAsync(() => api.platform.tenant(tenantId), [tenantId]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [impUser, setImpUser] = useState(null);
  const [editAdmin, setEditAdmin] = useState(false);

  const refresh = () => { reload(); onChanged?.(); };

  async function run(fn) {
    setBusy(true); setNotice(null);
    try { await fn(); refresh(); }
    catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  async function renew() { await run(() => api.platform.renew(tenantId, 1)); }
  async function changePlan(planKey) {
    if (!planKey) return;
    await run(() => api.platform.setSubscription(tenantId, { planKey }));
  }
  async function toggleStatus(status) {
    const next = status === 'suspended' ? 'active' : 'suspended';
    if (!window.confirm(`${next === 'suspended' ? 'Suspend' : 'Activate'} this admin workspace?`)) return;
    await run(() => api.platform.updateTenant(tenantId, { status: next }));
  }
  async function resetPassword(userId, label) {
    if (!window.confirm(`Reset password for ${label}? A new one-time password will be shown.`)) return;
    setBusy(true);
    try {
      const r = await api.platform.resetUserPassword(userId);
      setNotice(`New password for ${r.email}: ${r.password}`);
    } catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  const sub = data?.subscriptions?.find(s => ['active', 'trialing', 'past_due', 'suspended'].includes(s.status)) || data?.subscriptions?.[0];
  const admin = data?.admin;
  const users = data?.users || [];
  const orgs = data?.organizations || [];
  const tenantWideUsers = users.filter(u => u.organization_id == null && u.role !== 'admin');

  return (
    <Modal onClose={onClose} title={loading ? 'Loading…' : data?.name} subtitle={data ? `${data.slug} · workspace` : ''} wide>
      {loading ? <Muted>Loading…</Muted> : error ? <ErrorBox msg={error} /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {notice && (
            <div style={{ background: `${C.green}14`, border: `1px solid ${C.green}55`, borderRadius: 8, padding: '10px 12px', fontSize: 13, fontFamily: 'monospace' }}>
              {notice}
            </div>
          )}

          {/* Subscription */}
          <Section title="Subscription">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center' }}>
              <Field label="Plan">
                <select value={sub?.plan_key || ''} disabled={busy} onChange={e => changePlan(e.target.value)} style={{ ...inputStyle, padding: '6px 8px' }}>
                  {plans.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Status"><StatusPill status={sub?.status} /></Field>
              <Field label="Renews / expires"><span style={{ fontWeight: 600 }}>{fmtDate(sub?.current_period_end)}</span></Field>
              <div style={{ flex: 1 }} />
              <button style={btn} disabled={busy} onClick={renew}>+ Renew 1 month</button>
              <button style={btn} disabled={busy} onClick={() => toggleStatus(data.status)}>
                {data.status === 'suspended' ? 'Activate workspace' : 'Suspend workspace'}
              </button>
            </div>
          </Section>

          {/* Usage */}
          {data.usage && (
            <Section title="Usage">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
                <UsageStat label="Users" used={data.usage.users} max={data.usage.limits?.max_users} />
                <UsageStat label="Organizations" used={data.usage.organizations} max={data.usage.limits?.max_organizations} />
                <UsageStat label="Contacts" used={data.usage.contacts} max={data.usage.limits?.max_contacts} />
                <UsageStat label="Messages" used={data.usage.messages} />
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: C.textMuted }}>
                Last login: {data.usage.lastLogin ? new Date(data.usage.lastLogin).toLocaleString() : 'never'}
              </div>
            </Section>
          )}

          {/* Admin login */}
          <Section title="Admin login">
            {admin ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <UserAvatar name={admin.display_name || admin.username} />
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontWeight: 600 }}>{admin.display_name || admin.username}</div>
                  <div style={{ fontSize: 12, color: C.textMuted }}>{admin.email}{admin.is_active === false ? ' · disabled' : ''}</div>
                </div>
                <button style={btn} disabled={busy} onClick={() => setEditAdmin(true)}>Edit</button>
                <button style={btn} disabled={busy} onClick={() => resetPassword(admin.id, admin.email)}>Reset password</button>
                <button style={btnPrimary} disabled={busy || admin.is_active === false} onClick={() => setImpUser(admin)}>Impersonate</button>
              </div>
            ) : <Muted>No admin login found for this workspace.</Muted>}
          </Section>

          {/* Organizations → users */}
          <Section title={`Organizations (${orgs.length})`}>
            {orgs.length === 0 ? <Muted>No organizations yet.</Muted> : orgs.map(o => {
              const members = users.filter(u => u.organization_id === o.id);
              return (
                <div key={o.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: members.length ? 10 : 0 }}>
                    <span style={{ fontWeight: 700 }}>{o.name}</span>
                    <StatusPill status={o.status} />
                    <span style={{ fontSize: 12, color: C.textMuted }}>{o.member_count} member{o.member_count === 1 ? '' : 's'}</span>
                  </div>
                  {members.map(u => <UserRow key={u.id} u={u} busy={busy} onImpersonate={() => setImpUser(u)} onReset={() => resetPassword(u.id, u.email)} />)}
                </div>
              );
            })}
            {tenantWideUsers.length > 0 && (
              <div style={{ border: `1px dashed ${C.border}`, borderRadius: 10, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13, color: C.textSecondary }}>Tenant-wide users</div>
                {tenantWideUsers.map(u => <UserRow key={u.id} u={u} busy={busy} onImpersonate={() => setImpUser(u)} onReset={() => resetPassword(u.id, u.email)} />)}
              </div>
            )}
          </Section>
        </div>
      )}

      {editAdmin && admin && (
        <EditUserModal user={admin} onClose={() => setEditAdmin(false)} onSaved={() => { setEditAdmin(false); refresh(); }} />
      )}
      {impUser && <ImpersonateConfirm user={impUser} onClose={() => setImpUser(null)} />}
    </Modal>
  );
}

function UserRow({ u, busy, onImpersonate, onReset }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
      <UserAvatar name={u.display_name || u.username} small />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{u.display_name || u.username}</div>
        <div style={{ fontSize: 11.5, color: C.textMuted }}>{u.email} · {u.role}{u.is_active === false ? ' · disabled' : ''}</div>
      </div>
      <button style={{ ...btn, padding: '4px 9px', fontSize: 12 }} disabled={busy} onClick={onReset}>Reset pw</button>
      <button style={{ ...btnPrimary, padding: '4px 10px', fontSize: 12 }} disabled={busy || u.is_active === false} onClick={onImpersonate}>Impersonate</button>
    </div>
  );
}

function EditUserModal({ user, onClose, onSaved }) {
  const [displayName, setDisplayName] = useState(user.display_name || '');
  const [email, setEmail] = useState(user.email || '');
  const [isActive, setIsActive] = useState(user.is_active !== false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.platform.updateUser(user.id, { displayName: displayName.trim(), email: email.trim(), isActive });
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal onClose={onClose} title="Edit admin">
      {err && <ErrorBox msg={err} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Display name" block><input value={displayName} onChange={e => setDisplayName(e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Email (login)" block><input value={email} onChange={e => setEmail(e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} /> Active (can log in)
        </label>
      </div>
      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
        <button style={btnPrimary} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

function ImpersonateConfirm({ user, onClose }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    const reason = window.prompt(`Reason for impersonating ${user.display_name || user.email}? (required, audited)`);
    if (reason == null) return;
    if (!reason.trim()) { alert('A reason is required.'); return; }
    setBusy(true);
    try {
      await api.platform.impersonate(user.id, reason.trim());
      window.location.hash = '#/home';
      window.location.reload();
    } catch (e) { alert(e.message); setBusy(false); }
  }
  useEffect(() => { go(); /* eslint-disable-next-line */ }, []);
  return (
    <Modal onClose={busy ? undefined : onClose} title="Impersonate">
      <Muted>{busy ? 'Starting impersonation…' : 'Awaiting confirmation…'}</Muted>
    </Modal>
  );
}

// ─── Plans & pricing (editable) ──────────────────────────────────────────────
function Plans() {
  const { data, error, loading, reload } = useAsync(() => api.platform.plans(), []);
  const { data: allFeatures } = useAsync(() => api.platform.features(), []);
  const [editing, setEditing] = useState(null); // plan object or {} for new
  if (loading) return <Muted>Loading…</Muted>;
  if (error) return <ErrorBox msg={error} />;

  const fmt = (v) => (v == null ? '∞' : Number(v).toLocaleString());

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: C.textSecondary }}>Set pricing, limits and which features each plan unlocks.</div>
        <button style={btnPrimary} onClick={() => setEditing({})}>+ New plan</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
        {(data || []).map(p => (
          <div key={p.key} style={{ ...card, opacity: p.is_active ? 1 : 0.6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ fontSize: 16, fontWeight: 800 }}>{p.name}</div>
              {!p.is_active && <span style={{ fontSize: 10.5, fontWeight: 700, color: C.textMuted, background: C.pageBg, padding: '2px 7px', borderRadius: 6 }}>Hidden</span>}
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, margin: '6px 0' }}>
              {Number(p.price_monthly) === 0 ? 'Custom' : `$${p.price_monthly}`}<span style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>/mo</span>
            </div>
            <div style={{ fontSize: 12.5, color: C.textSecondary, marginBottom: 10, minHeight: 32 }}>{p.description}</div>
            <div style={{ fontSize: 12, color: C.textSecondary, lineHeight: 1.8 }}>
              <div>Users: {fmt(p.max_users)}</div>
              <div>Orgs: {fmt(p.max_organizations)}</div>
              <div>Contacts: {fmt(p.max_contacts)}</div>
            </div>
            <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {(p.features || []).map(f => (
                <span key={f} style={{ fontSize: 10.5, fontWeight: 600, color: C.primary, background: `${C.primary}14`, padding: '2px 7px', borderRadius: 6 }}>{f}</span>
              ))}
            </div>
            <div style={{ marginTop: 14 }}>
              <button style={{ ...btn, width: '100%' }} onClick={() => setEditing(p)}>Edit</button>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <PlanEditor plan={editing} allFeatures={allFeatures || []}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      )}
    </div>
  );
}

function PlanEditor({ plan, allFeatures, onClose, onSaved }) {
  const isNew = !plan.id;
  const [f, setF] = useState({
    name: plan.name || '', key: plan.key || '', description: plan.description || '',
    priceMonthly: plan.price_monthly ?? 0, priceYearly: plan.price_yearly ?? 0,
    maxUsers: plan.max_users ?? '', maxOrganizations: plan.max_organizations ?? '', maxContacts: plan.max_contacts ?? '',
    isActive: plan.is_active !== false,
  });
  const [features, setFeatures] = useState(new Set(plan.features || []));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const upd = (k, v) => setF(s => ({ ...s, [k]: v }));
  const toggleFeature = (key) => setFeatures(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  async function save() {
    if (!f.name.trim()) { setErr('Name is required'); return; }
    setBusy(true); setErr(null);
    try {
      const payload = {
        name: f.name.trim(), description: f.description,
        priceMonthly: f.priceMonthly, priceYearly: f.priceYearly,
        maxUsers: f.maxUsers === '' ? null : f.maxUsers,
        maxOrganizations: f.maxOrganizations === '' ? null : f.maxOrganizations,
        maxContacts: f.maxContacts === '' ? null : f.maxContacts,
        isActive: f.isActive,
      };
      const saved = isNew
        ? await api.platform.createPlan({ ...payload, key: f.key.trim() || undefined })
        : await api.platform.updatePlan(plan.id, payload);
      await api.platform.setPlanFeatures(saved.id, [...features]);
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal onClose={onClose} title={isNew ? 'New plan' : `Edit ${plan.name}`} wide>
      {err && <ErrorBox msg={err} />}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <Field label="Name" block><input value={f.name} onChange={e => upd('name', e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label={isNew ? 'Key (slug, optional)' : 'Key'} block>
          <input value={f.key} disabled={!isNew} onChange={e => upd('key', e.target.value)} style={{ ...inputStyle, width: '100%', opacity: isNew ? 1 : 0.6 }} placeholder="auto from name" />
        </Field>
        <Field label="Price / month ($)" block><input type="number" min="0" value={f.priceMonthly} onChange={e => upd('priceMonthly', e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Price / year ($)" block><input type="number" min="0" value={f.priceYearly} onChange={e => upd('priceYearly', e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Max users (blank = ∞)" block><input type="number" min="0" value={f.maxUsers} onChange={e => upd('maxUsers', e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Max organizations (blank = ∞)" block><input type="number" min="0" value={f.maxOrganizations} onChange={e => upd('maxOrganizations', e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Max contacts (blank = ∞)" block><input type="number" min="0" value={f.maxContacts} onChange={e => upd('maxContacts', e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={f.isActive} onChange={e => upd('isActive', e.target.checked)} /> Active (offered to admins)
          </label>
        </div>
      </div>
      <Field label="Description" block>
        <textarea value={f.description} onChange={e => upd('description', e.target.value)} rows={2} style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
      </Field>
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, marginBottom: 8 }}>FEATURES UNLOCKED BY THIS PLAN</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
          {allFeatures.map(ft => {
            const on = features.has(ft.key);
            return (
              <label key={ft.key} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', borderRadius: 9, cursor: 'pointer',
                fontSize: 13, fontWeight: 600, border: `1px solid ${on ? C.primary : C.border}`,
                background: on ? `${C.primary}10` : C.cardBg,
              }}>
                <input type="checkbox" checked={on} onChange={() => toggleFeature(ft.key)} />
                <span>{ft.name || ft.key}</span>
              </label>
            );
          })}
        </div>
      </div>
      <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
        <button style={btnPrimary} onClick={save} disabled={busy}>{busy ? 'Saving…' : isNew ? 'Create plan' : 'Save plan'}</button>
      </div>
    </Modal>
  );
}

// ─── Audit ───────────────────────────────────────────────────────────────────
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

// ─── Shared bits ─────────────────────────────────────────────────────────────
function Modal({ title, subtitle, children, onClose, wide }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 500, padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: wide ? 760 : 480, maxHeight: '86vh', overflow: 'auto',
        background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 18, boxShadow: C.shadowLg,
        animation: 'scaleInFast 0.18s cubic-bezier(0.16,1,0.3,1) both',
      }}>
        <div style={{ padding: '18px 22px', borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800 }}>{title}</div>
            {subtitle ? <div style={{ fontSize: 12.5, color: C.textSecondary, marginTop: 2 }}>{subtitle}</div> : null}
          </div>
          {onClose && <button onClick={onClose} style={{ ...btn, padding: '4px 10px' }}>✕</button>}
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}
function Section({ title, children }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.textSecondary }}>{title}</div>
      {children}
    </div>
  );
}
function Field({ label, children, block }) {
  return (
    <div style={{ display: block ? 'block' : 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
function UsageStat({ label, used, max }) {
  const unlimited = max == null;
  const pct = unlimited || !max ? 0 : Math.min(100, Math.round((used / max) * 100));
  const color = pct >= 90 ? '#DC2626' : pct >= 70 ? C.amber : C.green;
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 12, color: C.textSecondary, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, margin: '4px 0 8px' }}>
        {Number(used ?? 0).toLocaleString()}
        <span style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}> / {unlimited ? '∞' : Number(max).toLocaleString()}</span>
      </div>
      {!unlimited && max ? (
        <div style={{ height: 6, borderRadius: 6, background: C.pageBg, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 6 }} />
        </div>
      ) : null}
    </div>
  );
}
function UserAvatar({ name, small }) {
  const s = small ? 28 : 36;
  return (
    <span style={{ width: s, height: s, borderRadius: 9, background: `${C.primary}1f`, color: C.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0, fontSize: small ? 12 : 14 }}>
      {(name || '?').charAt(0).toUpperCase()}
    </span>
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
