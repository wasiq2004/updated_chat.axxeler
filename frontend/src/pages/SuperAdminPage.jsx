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
import {
  LayoutDashboard, Users, Building2, CreditCard, Palette, ScrollText,
  ChevronLeft, ChevronRight, TrendingUp, Bot, Contact,
  PlugZap, CheckCircle2, AlertTriangle, XCircle, Clock, ShieldAlert,
  KeyRound, Trash2, Receipt, Check,
} from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';
import { VIZ_CSS, STATUS, ordinalStep, compact } from '../lib/vizTokens.js';
import { fmtMoney } from '../lib/plans.js';
import { ChartCard, LineChart, BarChart, StatTile } from '../components/superadmin/Charts.jsx';

// Nav depends on the operator: the platform owner manages Partners (resellers);
// a white-label reseller manages their own Branding and can never see Partners.
function navGroupsFor(user) {
  const groups = [
    // Not "Platform" — the rail header above already says PLATFORM / Super Admin.
    { title: 'Overview', items: [{ key: 'overview', label: 'Dashboard', Icon: LayoutDashboard }] },
    {
      title: 'Customers', items: [
        { key: 'admins', label: 'Admins', Icon: Users },
        ...(user?.isSuperAdmin ? [{ key: 'partners', label: 'Partners', Icon: Building2 }] : []),
      ],
    },
    {
      title: 'Billing', items: [
        { key: 'plans', label: 'Plans', Icon: CreditCard },
        { key: 'requests', label: 'Plan Requests', Icon: Receipt },
      ],
    },
    {
      title: 'System', items: [
        ...(user?.isResellerAdmin ? [{ key: 'branding', label: 'Branding', Icon: Palette }] : []),
        { key: 'audit', label: 'Audit Log', Icon: ScrollText },
      ],
    },
  ];
  return groups.filter(g => g.items.length > 0);
}

const SECTION_TITLES = {
  overview: ['Dashboard', 'Platform health, growth and adoption at a glance.'],
  admins: ['Admins', 'Every customer account, their organizations, users and plan.'],
  partners: ['Partners', 'White-label resellers with their own branded login and console.'],
  plans: ['Plans', 'The plan catalog: pricing, limits and included features.'],
  requests: ['Plan Requests', 'Customers asking to buy a plan. Approving one activates it — collect payment first.'],
  branding: ['Branding', 'How your customers see your white-label workspace.'],
  audit: ['Audit Log', 'Every platform mutation, newest first.'],
};

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

export default function SuperAdminPage({ user }) {
  const [tab, setTab] = useState('overview');
  const [collapsed, setCollapsed] = useState(false);
  const GROUPS = navGroupsFor(user);
  const isReseller = !!user?.isResellerAdmin;
  // Only the platform owner can impersonate (the impersonation route is
  // super-admin-only); resellers manage but don't impersonate.
  const isSuper = !!user?.isSuperAdmin;
  const [title, subtitle] = SECTION_TITLES[tab] || SECTION_TITLES.overview;

  // Guard: if the visible nav no longer contains the active section (e.g. a
  // reseller landing on 'partners'), fall back to the dashboard.
  const visible = GROUPS.flatMap(g => g.items.map(i => i.key));
  useEffect(() => {
    if (!visible.includes(tab)) setTab('overview');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, user]);

  return (
    <div className="viz-root" style={{ display: 'flex', flex: 1, minHeight: 0, fontFamily: FONT, color: C.text }}>
      <style>{VIZ_CSS}</style>

      <ConsoleSidebar
        groups={GROUPS} active={tab} onSelect={setTab}
        collapsed={collapsed} setCollapsed={setCollapsed}
        isReseller={isReseller}
      />

      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        <div style={{ padding: '26px 30px 40px', maxWidth: 1240, margin: '0 auto', width: '100%' }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0, letterSpacing: '-0.025em' }}>{title}</h1>
          <p style={{ fontSize: 13, color: C.textSecondary, margin: '5px 0 22px' }}>{subtitle}</p>

          {tab === 'overview' && <Dashboard />}
          {tab === 'admins' && <Admins isSuper={isSuper} />}
          {tab === 'partners' && <Partners />}
          {tab === 'plans' && <Plans />}
          {tab === 'requests' && <PlanRequests />}
          {tab === 'branding' && <BrandingTab />}
          {tab === 'audit' && <Audit />}
        </div>
      </div>
    </div>
  );
}

// Console rail — mirrors the app's main Sidebar language (grouped sections,
// gradient active state with the amber inset, collapsible).
function ConsoleSidebar({ groups, active, onSelect, collapsed, setCollapsed, isReseller }) {
  return (
    <div style={{
      width: collapsed ? 68 : 226, flexShrink: 0, display: 'flex', flexDirection: 'column',
      background: 'linear-gradient(180deg, rgba(0,0,0,.06), rgba(0,0,0,.02)), var(--c-sidebarBg)',
      borderRight: `1px solid ${C.sidebarBorder}`, overflow: 'hidden',
      transition: 'width 0.25s cubic-bezier(0.16,1,0.3,1)',
    }}>
      <div style={{ padding: collapsed ? '14px 6px 10px' : '16px 14px 12px' }}>
        {!collapsed ? (
          <>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', color: C.primary }}>
              {isReseller ? 'White-label' : 'Platform'}
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.text, marginTop: 3, letterSpacing: '-0.02em' }}>
              {isReseller ? 'Partner Console' : 'Super Admin'}
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'center', color: C.primary }}><ShieldAlert size={19} /></div>
        )}
      </div>

      <div style={{ padding: collapsed ? '4px 6px' : '4px 10px', flex: 1, overflowY: 'auto' }}>
        {groups.map((group, gi) => (
          <div key={group.title} style={{ marginBottom: collapsed ? 4 : 10 }}>
            {!collapsed ? (
              <div style={{
                fontSize: 10, fontWeight: 800, letterSpacing: '.11em', textTransform: 'uppercase',
                color: C.textMuted, padding: '6px 12px 5px', opacity: 0.8,
              }}>{group.title}</div>
            ) : gi > 0 ? (
              <div style={{ height: 1, background: C.sidebarBorder, margin: '5px 12px' }} />
            ) : null}
            {group.items.map(item => {
              const on = active === item.key;
              // A real <button>: the section switcher must stay keyboard-reachable
              // (the tab bar this replaced used buttons).
              return (
                <button key={item.key} type="button" onClick={() => onSelect(item.key)}
                  title={collapsed ? item.label : ''} aria-current={on ? 'page' : undefined}
                  style={{
                    width: '100%', textAlign: 'left', border: 'none', fontFamily: FONT,
                    display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 11,
                    padding: collapsed ? '11px 0' : '10px 12px', borderRadius: 11, cursor: 'pointer',
                    marginBottom: 2, justifyContent: collapsed ? 'center' : 'flex-start',
                    background: on ? 'var(--c-primaryGradient, linear-gradient(135deg,#0FA8E0,#38CDF0))' : 'transparent',
                    color: on ? '#fff' : C.text, fontSize: 13, fontWeight: on ? 700 : 500,
                    whiteSpace: 'nowrap', overflow: 'hidden', userSelect: 'none',
                    transition: 'background .16s ease, transform .16s ease',
                    boxShadow: on ? 'inset 3px 0 0 var(--c-amber, #F6B100), 0 10px 26px rgba(15,168,224,.30)' : 'none',
                  }}
                  onMouseEnter={e => { if (!on) { e.currentTarget.style.background = 'var(--c-hover)'; e.currentTarget.style.transform = 'translateX(2px)'; } }}
                  onMouseLeave={e => { e.currentTarget.style.background = on ? 'var(--c-primaryGradient, linear-gradient(135deg,#0FA8E0,#38CDF0))' : 'transparent'; e.currentTarget.style.transform = 'none'; }}
                >
                  <span style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: on ? 1 : 0.72 }}>
                    <item.Icon size={16} strokeWidth={on ? 2.4 : 2} />
                  </span>
                  {!collapsed && <span style={{ flex: 1, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{ borderTop: `1px solid ${C.sidebarBorder}` }}>
        <button type="button" onClick={() => setCollapsed(p => !p)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          style={{
            width: '100%', border: 'none', background: 'transparent', fontFamily: FONT,
            display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
            padding: collapsed ? '12px 0' : '11px 14px', justifyContent: collapsed ? 'center' : 'flex-start',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--c-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <span style={{ display: 'flex', color: C.textSecondary }}>
            {collapsed ? <ChevronRight size={20} strokeWidth={2.5} /> : <ChevronLeft size={20} strokeWidth={2.5} />}
          </span>
          {!collapsed && <span style={{ fontSize: 13, fontWeight: 600, color: C.textSecondary }}>Collapse</span>}
        </button>
      </div>
    </div>
  );
}

// ─── Partners (white-label resellers) — platform owner only ──────────────────
function Partners() {
  const { data, error, loading, reload } = useAsync(() => api.platform.resellers(), []);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(null);
  const [creds, setCreds] = useState(null);          // partner whose credentials are open
  const [pendingDelete, setPendingDelete] = useState(null);

  async function toggle(r) {
    const next = r.status === 'suspended' ? 'active' : 'suspended';
    if (!window.confirm(`${next === 'suspended' ? 'Suspend' : 'Activate'} partner "${r.name}"?`)) return;
    setBusy(r.id);
    try { await api.platform.updateReseller(r.id, { status: next }); reload(); }
    catch (e) { alert(e.message); } finally { setBusy(null); }
  }

  // `loading && !data`, not `loading`: a refetch must not unmount the subtree —
  // that would tear down an open dialog (and with it a one-time password that
  // has already been issued and can never be shown again).
  if (loading && !data) return <Muted>Loading…</Muted>;
  if (error) return <ErrorBox msg={error} />;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: C.textSecondary }}>
          A partner gets their own branded login (<code>?w=slug</code>), their own console, plans and admins.
        </div>
        <button style={btnPrimary} onClick={() => setShowCreate(true)}>+ New partner</button>
      </div>
      {showCreate && <CreatePartner onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); reload(); }} />}
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
          <thead>
            <tr style={{ background: C.pageBg, textAlign: 'left', color: C.textSecondary }}>
              {['Partner', 'Login slug', 'Status', 'Admins', 'Users', ''].map(h => (
                <th key={h} style={{ padding: '11px 14px', fontWeight: 600, fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data || []).map(r => (
              <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
                <td style={{ padding: '11px 14px', fontWeight: 600 }}>
                  {r.branding?.brandName || r.name}
                  {r.admin_email && (
                    <div style={{ fontSize: 11.5, color: C.textMuted, fontWeight: 500, marginTop: 2 }}>{r.admin_email}</div>
                  )}
                </td>
                <td style={{ padding: '11px 14px', color: C.textSecondary }}>?w={r.slug}</td>
                <td style={{ padding: '11px 14px' }}><StatusPill status={r.status} /></td>
                <td style={{ padding: '11px 14px' }}>{r.admins}</td>
                <td style={{ padding: '11px 14px' }}>{r.users}</td>
                <td style={{ padding: '11px 14px', textAlign: 'right' }}>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button title="View login credentials" style={{ ...btn, padding: '5px 10px', fontSize: 12.5 }}
                      onClick={() => setCreds(r)}>
                      <KeyRound size={13} style={{ verticalAlign: '-2px' }} /> Credentials
                    </button>
                    <button style={{ ...btn, padding: '5px 10px', fontSize: 12.5 }} disabled={busy === r.id} onClick={() => toggle(r)}>
                      {r.status === 'suspended' ? 'Activate' : 'Suspend'}
                    </button>
                    <button title="Delete partner" aria-label={`Delete ${r.name}`}
                      style={{ ...btn, padding: '5px 9px', color: '#DC2626' }}
                      disabled={busy === r.id} onClick={() => setPendingDelete(r)}>
                      <Trash2 size={14} style={{ verticalAlign: '-2px' }} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {(data || []).length === 0 && (
              <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: C.textMuted }}>No partners yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {creds && <PartnerCredentials partner={creds} onClose={() => setCreds(null)} />}
      {pendingDelete && (
        <DeletePartner partner={pendingDelete} onClose={() => setPendingDelete(null)}
          onDeleted={() => { setPendingDelete(null); reload(); }} />
      )}
    </div>
  );
}

// ─── Partner credentials ─────────────────────────────────────────────────────
// Everything needed to hand a partner their console access. The password is NOT
// shown — it is stored as a one-way bcrypt hash and cannot be read back by
// anyone, so the only honest option is to issue a new one (shown once).
function PartnerCredentials({ partner, onClose }) {
  const [pw, setPw] = useState(null);      // freshly issued password, shown once
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const loginUrl = `${window.location.origin}/?w=${partner.slug}`;

  async function reset() {
    setBusy(true); setErr(null);
    try {
      const r = await api.platform.resetResellerPassword(partner.id);
      setPw(r.password);
      setConfirming(false);
      // Deliberately no list refetch here: nothing shown in the table changes,
      // and a refetch would risk re-rendering away the one-time password.
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose} title={`Credentials — ${partner.branding?.brandName || partner.name}`}>
      {err && <ErrorBox msg={err} />}
      <CredRow label="Login URL" value={loginUrl} />
      <CredRow label="Admin email" value={partner.admin_email || '—'} />
      <CredRow label="Username" value={partner.admin_username || '—'} />
      <CredRow label="Last login" value={partner.admin_last_login_at ? fmtDate(partner.admin_last_login_at) : 'Never'} copyable={false} />
      <CredRow label="Login enabled" value={partner.admin_is_active === false ? 'No — disabled' : 'Yes'} copyable={false} />

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6 }}>Password</div>
        {pw ? (
          <div style={{ background: C.pageBg, borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 6 }}>✓ New password issued — copy it now, it won’t be shown again.</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <code style={{ fontFamily: 'Geist Mono, monospace', fontSize: 15, fontWeight: 700, flex: 1 }}>{pw}</code>
              <button style={{ ...btn, padding: '5px 10px', fontSize: 12 }}
                onClick={() => navigator.clipboard?.writeText(pw)}>Copy</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.55, marginBottom: 10 }}>
              Stored passwords are hashed and can never be displayed — not even here. If the partner
              lost theirs, issue a new one and send it to them.
            </div>
            {confirming ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12.5, color: C.text, fontWeight: 600 }}>
                  This replaces their current password immediately.
                </span>
                <button style={{ ...btnPrimary, padding: '6px 12px', fontSize: 12.5 }} disabled={busy} onClick={reset}>
                  {busy ? 'Resetting…' : 'Yes, reset'}
                </button>
                <button style={{ ...btn, padding: '6px 12px', fontSize: 12.5 }} onClick={() => setConfirming(false)}>Cancel</button>
              </div>
            ) : (
              <button style={{ ...btn, padding: '7px 12px', fontSize: 12.5 }} onClick={() => setConfirming(true)}>
                <KeyRound size={13} style={{ verticalAlign: '-2px' }} /> Issue new password
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function CredRow({ label, value, copyable = true }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
      <div style={{ width: 110, fontSize: 12, color: C.textSecondary, fontWeight: 600, flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, fontSize: 13, fontFamily: 'Geist Mono, monospace', wordBreak: 'break-all' }}>{value}</div>
      {copyable && value && value !== '—' && (
        <button style={{ ...btn, padding: '4px 8px', fontSize: 11 }}
          onClick={() => navigator.clipboard?.writeText(value)}>Copy</button>
      )}
    </div>
  );
}

// ─── Delete partner ──────────────────────────────────────────────────────────
function DeletePartner({ partner, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const name = partner.branding?.brandName || partner.name;

  async function go() {
    setBusy(true); setErr(null);
    try { await api.platform.deleteReseller(partner.id); onDeleted(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal onClose={onClose} title={`Delete “${name}”?`}>
      {err && <ErrorBox msg={err} />}
      <div style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.6 }}>
        Their branded login (<code>?w={partner.slug}</code>) stops working and the partner admin can
        no longer sign in. Their plan catalog and any past records are kept, not destroyed.
      </div>
      {partner.admins > 0 && (
        <div style={{
          marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.55,
          background: 'rgba(245,158,11,.12)', color: '#B45309', border: '1px solid rgba(245,158,11,.3)',
        }}>
          This partner still has <b>{partner.admins}</b> admin account(s). Deleting is blocked while they
          exist — those customers would be left with no owner. Remove them first, or suspend the partner instead.
        </div>
      )}
      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
        <button
          style={{ ...btnPrimary, background: '#DC2626', opacity: partner.admins > 0 ? 0.5 : 1 }}
          disabled={busy || partner.admins > 0}
          onClick={go}
        >
          {busy ? 'Deleting…' : 'Delete partner'}
        </button>
      </div>
    </Modal>
  );
}

// (The shared <Modal> used by these dialogs is defined further down this file.)

function CreatePartner({ onClose, onCreated }) {
  const [f, setF] = useState({ name: '', adminEmail: '', adminName: '', adminPassword: '', brandName: '', primaryColor: '', logoUrl: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [created, setCreated] = useState(null);
  const upd = (k, v) => setF(s => ({ ...s, [k]: v }));

  async function submit() {
    if (!f.name.trim()) { setErr('Partner name is required'); return; }
    if (!f.adminEmail.trim()) { setErr('Partner admin email is required'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.platform.createReseller({
        name: f.name.trim(), adminEmail: f.adminEmail.trim(),
        adminName: f.adminName.trim() || undefined, adminPassword: f.adminPassword.trim() || undefined,
        branding: { brandName: f.brandName.trim() || f.name.trim(), primaryColor: /^#[0-9a-fA-F]{6}$/.test(f.primaryColor) ? f.primaryColor : undefined, logoUrl: f.logoUrl.trim() || undefined },
      });
      setCreated({ email: f.adminEmail.trim(), password: r.generatedPassword || f.adminPassword.trim(), slug: r.slug });
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  if (created) {
    return (
      <div style={{ ...card, marginBottom: 14, borderColor: C.green }}>
        <div style={{ fontWeight: 700, marginBottom: 8, color: C.green }}>✓ Partner created</div>
        <div style={{ fontSize: 13, color: C.textSecondary, marginBottom: 10 }}>Give the partner their console login. Their customers log in at <b>?w={created.slug}</b>.</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, fontFamily: 'monospace', background: C.pageBg, padding: 12, borderRadius: 8 }}>
          <div>Email: <b>{created.email}</b></div>
          <div>Password: <b>{created.password}</b></div>
        </div>
        <div style={{ marginTop: 12, textAlign: 'right' }}><button style={btnPrimary} onClick={onCreated}>Done</button></div>
      </div>
    );
  }

  return (
    <div style={{ ...card, marginBottom: 14 }}>
      <div style={{ fontWeight: 700, marginBottom: 12 }}>Create white-label partner</div>
      {err && <ErrorBox msg={err} />}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <input autoFocus placeholder="Partner / company name" value={f.name} onChange={e => upd('name', e.target.value)} style={inputStyle} />
        <input placeholder="Partner admin email (login)" value={f.adminEmail} onChange={e => upd('adminEmail', e.target.value)} style={inputStyle} />
        <input placeholder="Admin display name (optional)" value={f.adminName} onChange={e => upd('adminName', e.target.value)} style={inputStyle} />
        <input placeholder="Password (blank = auto)" value={f.adminPassword} onChange={e => upd('adminPassword', e.target.value)} style={inputStyle} />
        <input placeholder="Brand name (shown to their users)" value={f.brandName} onChange={e => upd('brandName', e.target.value)} style={inputStyle} />
        <input placeholder="Accent color #RRGGBB" value={f.primaryColor} onChange={e => upd('primaryColor', e.target.value)} style={inputStyle} />
        <input placeholder="Logo URL (optional)" value={f.logoUrl} onChange={e => upd('logoUrl', e.target.value)} style={inputStyle} />
      </div>
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
        <button style={btnPrimary} onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create partner'}</button>
      </div>
    </div>
  );
}

// ─── Branding (a reseller editing its own white-label) ───────────────────────
function BrandingTab() {
  const { data, error, loading, reload } = useAsync(() => api.platform.myReseller(), []);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setF({
      name: data.name || '',
      brandName: data.branding?.brandName || '',
      primaryColor: data.branding?.primaryColor || '',
      logoUrl: data.branding?.logoUrl || '',
      loginTagline: data.branding?.loginTagline || '',
    });
  }, [data]);
  if (loading || !f) return <Muted>Loading…</Muted>;
  if (error) return <ErrorBox msg={error} />;
  const upd = (k, v) => { setF(s => ({ ...s, [k]: v })); setSaved(false); };

  async function save() {
    setBusy(true);
    try {
      await api.platform.updateMyReseller({
        name: f.name.trim() || undefined,
        branding: {
          brandName: f.brandName.trim(),
          primaryColor: /^#[0-9a-fA-F]{6}$/.test(f.primaryColor) ? f.primaryColor : undefined,
          logoUrl: f.logoUrl.trim(),
          loginTagline: f.loginTagline.trim(),
        },
      });
      setSaved(true); reload();
    } catch (e) { alert(e.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <Section title="Your white-label branding">
        <div style={{ fontSize: 12.5, color: C.textSecondary, marginBottom: 14 }}>
          Your customers log in at <b>?w={data.slug}</b> and see this branding across the app.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Brand name" block><input value={f.brandName} onChange={e => upd('brandName', e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
          <Field label="Accent color (#RRGGBB)" block>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input value={f.primaryColor} onChange={e => upd('primaryColor', e.target.value)} placeholder="var(--c-primary)" style={{ ...inputStyle, flex: 1 }} />
              <span style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${C.border}`, background: /^#[0-9a-fA-F]{6}$/.test(f.primaryColor) ? f.primaryColor : '#fff' }} />
            </div>
          </Field>
          <Field label="Logo URL" block><input value={f.logoUrl} onChange={e => upd('logoUrl', e.target.value)} placeholder="https://…/logo.png" style={{ ...inputStyle, width: '100%' }} /></Field>
          <Field label="Login tagline" block><input value={f.loginTagline} onChange={e => upd('loginTagline', e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        </div>
        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button style={btnPrimary} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save branding'}</button>
          {saved && <span style={{ color: C.green, fontSize: 13, fontWeight: 600 }}>✓ Saved</span>}
        </div>
      </Section>
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

// ─── Dashboard (platform analytics) ──────────────────────────────────────────

const RANGES = [7, 30, 90];
const fmtDay = (d) => {
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

function Dashboard() {
  const [days, setDays] = useState(30);
  const stats = useAsync(() => api.platform.stats(), []);
  const an = useAsync(() => api.platform.analytics(days), [days]);

  if (stats.loading && !stats.data) return <Muted>Loading…</Muted>;
  if (stats.error) return <ErrorBox msg={stats.error} />;

  const s = stats.data || {};
  const a = an.data || {};
  const mrr = Number(s.mrr || 0);            // pg NUMERIC arrives as a string
  const adoption = a.adoption || {};
  const lifecycle = a.lifecycle || {};
  const mix = a.status_mix || {};
  const dist = s.plan_distribution || [];

  // Refetching holds the previous render at reduced opacity — no skeleton flash,
  // no layout jump.
  const dim = an.loading && an.data ? 0.55 : 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* KPI row — the numbers that ARE the chart */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        {/* Label kept short so it stays on one line and the hero value aligns
            with the tiles beside it. */}
        <StatTile hero label="Monthly revenue" value={fmtMoney(mrr)} tone="var(--viz-good)" icon={<TrendingUp size={14} />} />
        <StatTile label="Active admins" value={compact(s.active_tenants ?? 0)} icon={<Users size={13} />} />
        <StatTile label="Users" value={compact(s.users ?? 0)} icon={<Users size={13} />} />
        <StatTile label="Active users (30d)" value={compact(adoption.mau ?? 0)} icon={<CheckCircle2 size={13} />} />
        <StatTile label="Expiring ≤7 days" value={compact(s.expiring_soon ?? 0)}
          tone={(s.expiring_soon ?? 0) > 0 ? 'var(--viz-warning)' : undefined} icon={<Clock size={13} />} />
      </div>

      {/* ONE filter row above everything it scopes — never per-chart filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '.06em' }}>Range</span>
        <div style={{ display: 'flex', gap: 4, background: C.surfaceAlt, padding: 3, borderRadius: 9 }}>
          {RANGES.map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              padding: '5px 11px', borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: FONT,
              fontSize: 12, fontWeight: 700,
              background: days === d ? C.cardBg : 'transparent',
              color: days === d ? C.text : C.textSecondary,
              boxShadow: days === d ? C.shadowSm : 'none',
            }}>Last {d} days</button>
          ))}
        </div>
        {an.error && <span style={{ fontSize: 12, color: C.error }}>Analytics unavailable — {an.error}</span>}
      </div>

      <div style={{ opacity: dim, transition: 'opacity .18s', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Trends — two separate charts, never a dual axis */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
          <ChartCard
            title="New admins" subtitle={`Accounts created · last ${days} days`}
            table={{
              columns: [{ key: 'day', label: 'Day' }, { key: 'count', label: 'New admins', align: 'right' }],
              rows: (a.signups || []).map(r => ({ day: fmtDay(r.day), count: r.count })),
            }}
          >
            <LineChart data={a.signups || []} series={[{ key: 'count', label: 'New admins' }]} area formatX={fmtDay} />
          </ChartCard>

          <ChartCard
            title="Message volume" subtitle={`Inbound vs outbound · last ${days} days`}
            table={{
              columns: [
                { key: 'day', label: 'Day' },
                { key: 'incoming', label: 'Inbound', align: 'right' },
                { key: 'outgoing', label: 'Outbound', align: 'right' },
              ],
              rows: (a.messages || []).map(r => ({ day: fmtDay(r.day), incoming: r.incoming, outgoing: r.outgoing })),
            }}
          >
            <LineChart
              data={a.messages || []}
              series={[{ key: 'incoming', label: 'Inbound' }, { key: 'outgoing', label: 'Outbound' }]}
              formatX={fmtDay}
            />
          </ChartCard>
        </div>

        {/* Magnitude comparisons */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
          <ChartCard
            title="Subscriptions by plan" subtitle="Live subscriptions per tier"
            table={{
              columns: [
                { key: 'plan', label: 'Plan' },
                { key: 'tenants', label: 'Admins', align: 'right' },
                { key: 'price', label: 'Price/mo', align: 'right' },
              ],
              rows: dist.map(d => ({ plan: d.plan_name, tenants: d.tenants, price: fmtMoney(d.price_monthly) })),
            }}
          >
            {/* Plans are ordered TIERS → one hue, monotone lightness (ordinal ramp) */}
            <BarChart
              labelWidth={104}
              data={dist.map((d, i) => ({
                label: d.plan_name, value: d.tenants,
                color: ordinalStep(i, Math.max(1, dist.length)),
                hint: `${fmtMoney(d.price_monthly)}/mo`,
              }))}
            />
          </ChartCard>

          <ChartCard
            title="Busiest admins" subtitle={`By messages · last ${days} days`}
            table={{
              columns: [{ key: 'name', label: 'Admin' }, { key: 'messages', label: 'Messages', align: 'right' }],
              rows: (a.top_tenants || []).map(t => ({ name: t.name, messages: Number(t.messages).toLocaleString() })),
            }}
          >
            {/* One series → one color (slot 1). Never a value-ramp on nominal names. */}
            <BarChart
              labelWidth={130}
              data={(a.top_tenants || []).map(t => ({ label: t.name, value: t.messages, hint: 'Messages' }))}
            />
          </ChartCard>
        </div>

        {/* Adoption */}
        <div>
          <SubHead>Product adoption</SubHead>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <StatTile label="WhatsApp connected" value={compact(adoption.wa_accounts ?? 0)} icon={<PlugZap size={13} />} />
            <StatTile label="Via Facebook signup" value={compact(adoption.wa_via_facebook ?? 0)} icon={<PlugZap size={13} />} />
            <StatTile label="AI agents" value={compact(adoption.agents ?? 0)} icon={<Bot size={13} />} />
            <StatTile label="Contacts" value={compact(adoption.contacts ?? 0)} icon={<Contact size={13} />} />
            <StatTile label="Not activated" value={compact(adoption.not_activated ?? 0)}
              tone={(adoption.not_activated ?? 0) > 0 ? 'var(--viz-serious)' : undefined} icon={<AlertTriangle size={13} />} />
          </div>
        </div>

        {/* Lifecycle — status colors always ship with an icon + label */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
          <ChartCard title="Admin lifecycle" subtitle="Account states across the base">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, paddingTop: 2 }}>
              <StateRow icon={<CheckCircle2 size={14} />} color={STATUS.good} label="Active" value={mix.active ?? 0} />
              <StateRow icon={<Clock size={14} />} color={STATUS.warning} label="Trial" value={mix.trial ?? 0} />
              <StateRow icon={<AlertTriangle size={14} />} color={STATUS.serious} label="Suspended" value={mix.suspended ?? 0} />
              <StateRow icon={<XCircle size={14} />} color={STATUS.critical} label="Cancelled" value={mix.cancelled ?? 0} />
            </div>
          </ChartCard>

          <ChartCard title="Renewals at risk" subtitle="Live subscriptions approaching their period end">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9, paddingTop: 2 }}>
              <StateRow icon={<Clock size={14} />} color={STATUS.critical} label="Expiring ≤7 days" value={lifecycle.expiring_7d ?? 0} />
              <StateRow icon={<Clock size={14} />} color={STATUS.serious} label="Expiring ≤14 days" value={lifecycle.expiring_14d ?? 0} />
              <StateRow icon={<Clock size={14} />} color={STATUS.warning} label="Expiring ≤30 days" value={lifecycle.expiring_30d ?? 0} />
              <StateRow icon={<XCircle size={14} />} color={STATUS.critical} label="Pending cancellation" value={lifecycle.pending_cancellations ?? 0} />
            </div>
          </ChartCard>
        </div>
      </div>
    </div>
  );
}

function SubHead({ children }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 800, color: C.textMuted, textTransform: 'uppercase',
      letterSpacing: '.08em', margin: '2px 0 10px',
    }}>{children}</div>
  );
}

// A state row: colored icon + text label + value. Never color alone.
function StateRow({ icon, color, label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ display: 'flex', color, flexShrink: 0 }}>{icon}</span>
      <span style={{ fontSize: 13, color: C.textSecondary, flex: 1, fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 800, color: C.text, fontVariantNumeric: 'tabular-nums' }}>
        {Number(value || 0).toLocaleString()}
      </span>
    </div>
  );
}

// ─── Admins (tenants) ────────────────────────────────────────────────────────
function Admins({ isSuper }) {
  const { data, error, loading, reload } = useAsync(() => api.platform.tenants(), []);
  const { data: plans } = useAsync(() => api.platform.plans(), []);
  const [showCreate, setShowCreate] = useState(false);
  const [detailFor, setDetailFor] = useState(null); // tenant id open in the drill-down
  const [pendingDelete, setPendingDelete] = useState(null);

  // `loading && !data` (not bare `loading`): a reload after a delete must not
  // unmount the table and any dialog mounted beside it.
  if (loading && !data) return <Muted>Loading…</Muted>;
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
                  {/* stopPropagation on both: the whole row opens the drill-down,
                      so without it a delete click also fires that. */}
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button style={{ ...btn, padding: '5px 10px', fontSize: 12.5 }}
                      onClick={(e) => { e.stopPropagation(); setDetailFor(t.id); }}>
                      Manage →
                    </button>
                    <button
                      title="Delete admin"
                      aria-label={`Delete ${t.name}`}
                      style={{ ...btn, padding: '5px 9px', color: '#DC2626' }}
                      onClick={(e) => { e.stopPropagation(); setPendingDelete(t); }}
                    >
                      <Trash2 size={14} style={{ verticalAlign: '-2px' }} />
                    </button>
                  </div>
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
        <AdminDetail tenantId={detailFor} plans={plans || []} isSuper={isSuper} onClose={() => setDetailFor(null)} onChanged={reload} />
      )}
      {pendingDelete && (
        <DeleteAdmin
          admin={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onDeleted={() => { setPendingDelete(null); reload(); }}
        />
      )}
    </div>
  );
}

// ─── Delete admin (workspace) ────────────────────────────────────────────────
// Soft delete: the workspace disappears from the console and its people can no
// longer sign in, but nothing is destroyed. The dialog says so explicitly —
// "delete" that silently shredded a customer's entire chat history would be a
// nasty surprise, and this one genuinely doesn't.
function DeleteAdmin({ admin, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState('');
  // Typing the name is required because, unlike the partner delete, there is no
  // child-count guard to catch a misclick: any workspace can be deleted at any
  // time, including a busy one with live conversations.
  const matches = confirm.trim().toLowerCase() === admin.name.trim().toLowerCase();

  async function go() {
    if (!matches) return;
    setBusy(true); setErr(null);
    try { await api.platform.deleteTenant(admin.id); onDeleted(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal onClose={onClose} title={`Delete “${admin.name}”?`}>
      {err && <ErrorBox msg={err} />}
      <div style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.6 }}>
        Their workspace is removed from this console and all <b>{admin.users}</b> of their
        logins stop working immediately. Their subscription is cancelled and any pending
        plan request is withdrawn.
      </div>
      <div style={{
        marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.55,
        background: 'rgba(17,131,180,.10)', color: C.textSecondary, border: `1px solid ${C.border}`,
      }}>
        Conversations, contacts and connected WhatsApp numbers are <b>kept</b>, not destroyed —
        this is reversible in the database. Their email addresses are released, so they can
        sign up again later.
      </div>
      {admin.users > 1 && (
        <div style={{
          marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.55,
          background: 'rgba(245,158,11,.12)', color: '#B45309', border: '1px solid rgba(245,158,11,.3)',
        }}>
          This locks out <b>{admin.users}</b> people, not just the owner.
        </div>
      )}
      <label style={{ display: 'block', marginTop: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, marginBottom: 6 }}>
          Type <b style={{ color: C.text }}>{admin.name}</b> to confirm
        </div>
        <input
          style={{ ...inputStyle, width: '100%' }}
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          placeholder={admin.name}
          autoFocus
        />
      </label>
      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
        <button
          style={{ ...btnPrimary, background: '#DC2626', opacity: matches ? 1 : 0.5 }}
          disabled={busy || !matches}
          onClick={go}
        >
          {busy ? 'Deleting…' : 'Delete admin'}
        </button>
      </div>
    </Modal>
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
function AdminDetail({ tenantId, plans, isSuper, onClose, onChanged }) {
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
                {isSuper && (
                  <button style={btnPrimary} disabled={busy || admin.is_active === false} onClick={() => setImpUser(admin)}>Impersonate</button>
                )}
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
                  {members.map(u => <UserRow key={u.id} u={u} busy={busy} canImpersonate={isSuper} onImpersonate={() => setImpUser(u)} onReset={() => resetPassword(u.id, u.email)} />)}
                </div>
              );
            })}
            {tenantWideUsers.length > 0 && (
              <div style={{ border: `1px dashed ${C.border}`, borderRadius: 10, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13, color: C.textSecondary }}>Tenant-wide users</div>
                {tenantWideUsers.map(u => <UserRow key={u.id} u={u} busy={busy} canImpersonate={isSuper} onImpersonate={() => setImpUser(u)} onReset={() => resetPassword(u.id, u.email)} />)}
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

function UserRow({ u, busy, canImpersonate, onImpersonate, onReset }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
      <UserAvatar name={u.display_name || u.username} small />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{u.display_name || u.username}</div>
        <div style={{ fontSize: 11.5, color: C.textMuted }}>{u.email} · {u.role}{u.is_active === false ? ' · disabled' : ''}</div>
      </div>
      <button style={{ ...btn, padding: '4px 9px', fontSize: 12 }} disabled={busy} onClick={onReset}>Reset pw</button>
      {canImpersonate && (
        <button style={{ ...btnPrimary, padding: '4px 10px', fontSize: 12 }} disabled={busy || u.is_active === false} onClick={onImpersonate}>Impersonate</button>
      )}
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
              {Number(p.price_monthly) === 0 ? 'Custom' : fmtMoney(p.price_monthly, p.currency)}<span style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>/mo</span>
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
        <Field label="Price / month (₹)" block><input type="number" min="0" value={f.priceMonthly} onChange={e => upd('priceMonthly', e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
        <Field label="Price / year (₹)" block><input type="number" min="0" value={f.priceYearly} onChange={e => upd('priceYearly', e.target.value)} style={{ ...inputStyle, width: '100%' }} /></Field>
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
// ─── Plan requests ───────────────────────────────────────────────────────────
// Customers can't charge themselves — there's no gateway — so a chosen plan
// lands here. Approving performs the same subscription change as the Admins tab,
// which is why the button says what it does: money first, then activate.
function PlanRequests() {
  const [status, setStatus] = useState('pending');
  const { data, error, loading, reload } = useAsync(() => api.platform.planRequests(status), [status]);
  const [busy, setBusy] = useState(0);
  const [actionErr, setActionErr] = useState('');

  const act = async (id, fn) => {
    setActionErr('');
    setBusy(id);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionErr(e.message || 'Action failed.');
    } finally {
      setBusy(0);
    }
  };

  if (loading && !data) return <Muted>Loading…</Muted>;
  if (error) return <ErrorBox msg={error} />;
  const rows = data || [];

  return (
    <>
      {actionErr && <ErrorBox msg={actionErr} />}
      <div style={{ display: 'flex', gap: 4, padding: 4, marginBottom: 16, background: C.surfaceAlt, borderRadius: 9, width: 'fit-content' }}>
        {[['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']].map(([key, label]) => {
          const active = status === key;
          return (
            <button
              key={key} type="button" aria-pressed={active}
              onClick={() => setStatus(key)}
              style={{
                padding: '6px 14px', borderRadius: 7, border: 'none', cursor: 'pointer',
                fontFamily: FONT, fontSize: 12.5, fontWeight: 700,
                background: active ? C.cardBg : 'transparent',
                color: active ? C.text : C.textSecondary,
                boxShadow: active ? '0 1px 4px rgba(0,0,0,0.10)' : 'none',
              }}
            >{label}</button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', padding: 40 }}>
          <Receipt size={26} color={C.textMuted} style={{ marginBottom: 10 }} />
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>
            No {status} requests
          </div>
          <div style={{ fontSize: 13, color: C.textMuted }}>
            When a customer picks a plan from their billing page, it shows up here.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map(r => (
            <div key={r.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 14.5, fontWeight: 800, marginBottom: 3 }}>{r.tenant.name}</div>
                <div style={{ fontSize: 12.5, color: C.textSecondary }}>
                  {r.currentPlan ? r.currentPlan.name : 'No plan'} → <strong style={{ color: C.text }}>{r.plan.name}</strong>
                  {' · '}{r.billingCycle}
                </div>
                {r.requestedBy && (
                  <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 3 }}>
                    Requested by {r.requestedBy.name || r.requestedBy.email} · {fmtDate(r.createdAt)}
                  </div>
                )}
                {r.note && (
                  <div style={{ fontSize: 12, color: C.textSecondary, marginTop: 6, fontStyle: 'italic' }}>“{r.note}”</div>
                )}
              </div>

              <div style={{ textAlign: 'right', minWidth: 110 }}>
                <div style={{ fontSize: 17, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                  {fmtMoney(
                    Number(r.billingCycle === 'yearly' ? r.plan.priceYearly : r.plan.priceMonthly),
                    r.plan.currency
                  )}
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600 }}>
                  {r.billingCycle === 'yearly' ? 'per year' : 'per month'}
                </div>
              </div>

              {r.status === 'pending' ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button" disabled={busy === r.id}
                    onClick={() => act(r.id, () => api.platform.approvePlanRequest(r.id))}
                    style={{ ...btnPrimary, display: 'inline-flex', alignItems: 'center', gap: 6, opacity: busy === r.id ? 0.6 : 1 }}
                  >
                    <Check size={14} /> {busy === r.id ? 'Working…' : 'Approve & activate'}
                  </button>
                  <button
                    type="button" disabled={busy === r.id}
                    onClick={() => act(r.id, () => api.platform.rejectPlanRequest(r.id))}
                    style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    <XCircle size={14} /> Reject
                  </button>
                </div>
              ) : (
                <span style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>
                  {r.status} · {fmtDate(r.decidedAt)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
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
