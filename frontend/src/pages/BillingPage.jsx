// Plan & Billing — the tenant's current plan, usage meters, and a plan
// comparison grid.
//
// Buying: there is no payment gateway, so an admin can't switch their own plan
// directly. Choosing a plan files a REQUEST that an operator approves once
// payment is collected out of band. From the customer's side it's a real action
// with real feedback, not the dead "contact your account manager" text this page
// used to end on.

import { useState, useEffect, useCallback } from 'react';
import { Check, Minus, Crown, TrendingUp, Users, Building2, Contact, Clock, X } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';
import { PLAN_META, FEATURE_LABELS, formatLimit, fmtMoney } from '../lib/plans.js';

// Preferred display order; any feature the backend catalog exposes that isn't
// listed here is appended so newly-added/custom features still show in the grid.
const PREFERRED_FEATURE_ORDER = [
  'inbox', 'crm', 'deals', 'campaigns', 'broadcast', 'automations',
  'ai_agents', 'analytics', 'api_access', 'webhooks', 'white_label', 'marketplace',
];
function orderedFeatures(catalog) {
  const known = (catalog?.features || []).map(f => f.key);
  const seen = new Set();
  const out = [];
  for (const k of PREFERRED_FEATURE_ORDER) { if (known.length === 0 || known.includes(k)) { out.push(k); seen.add(k); } }
  for (const k of known) { if (!seen.has(k)) out.push(k); }
  return out;
}

function UsageMeter({ icon: Icon, label, used, max }) {
  const unlimited = max == null;
  const pct = unlimited || !max ? 0 : Math.min(100, Math.round((used / max) * 100));
  const color = pct >= 90 ? '#DC2626' : pct >= 70 ? C.amber : C.green;
  return (
    <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18, boxShadow: C.shadowSm }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, background: `${color}1a`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={16} color={color} />
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.textSecondary }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 10 }}>
        <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em' }}>{Number(used ?? 0).toLocaleString()}</span>
        <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 600 }}>/ {unlimited ? '∞' : Number(max).toLocaleString()}</span>
      </div>
      <div style={{ height: 7, borderRadius: 6, background: C.surfaceAlt, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: unlimited ? '12%' : `${pct}%`, borderRadius: 6,
          background: unlimited ? `linear-gradient(90deg, ${C.green}, ${C.purple})` : color,
          transition: 'width 0.7s cubic-bezier(0.16,1,0.3,1)',
          boxShadow: `0 0 12px ${unlimited ? C.purple : color}66`,
        }} />
      </div>
      <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 7 }}>
        {unlimited ? 'Unlimited on your plan' : pct >= 90 ? 'Almost full — consider upgrading' : `${pct}% used`}
      </div>
    </div>
  );
}

export default function BillingPage({ entitlements: initial, user }) {
  const [ent, setEnt] = useState(initial || null);
  const [loading, setLoading] = useState(!initial);
  const [request, setRequest] = useState(null);   // the tenant's pending plan request
  const [busy, setBusy] = useState('');           // plan key currently being submitted
  const [cycle, setCycle] = useState('monthly');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (initial) { setEnt(initial); return; }
    api.billing.entitlements().then(setEnt).catch(() => {}).finally(() => setLoading(false));
  }, [initial]);

  const reloadRequest = useCallback(() => {
    api.billing.planRequest().then(r => setRequest(r.request)).catch(() => setRequest(null));
  }, []);
  useEffect(() => { reloadRequest(); }, [reloadRequest]);

  // Only a workspace admin can change the plan — the backend enforces this, so
  // showing the button to anyone else just produces an error.
  //
  // hasWorkspace, not role alone: a PARTNER console admin is also role='admin'
  // but has no tenant of their own, so every buy button they saw 400'd with
  // "No workspace on this account". `!== false` keeps this working against a
  // backend that predates the field.
  const canBuy = !!ent
    && !ent.isSuperAdmin
    && ent.hasWorkspace !== false
    && !ent.isResellerAdmin
    && user?.role === 'admin';

  const choosePlan = async (planKey) => {
    setErr('');
    setBusy(planKey);
    try {
      await api.billing.requestPlan(planKey, cycle);
      reloadRequest();
    } catch (e) {
      setErr(e.message || 'Could not submit your request.');
    } finally {
      setBusy('');
    }
  };

  const withdraw = async () => {
    setErr('');
    try {
      await api.billing.cancelPlanRequest();
      reloadRequest();
    } catch (e) {
      setErr(e.message || 'Could not withdraw the request.');
    }
  };

  if (loading || !ent) {
    return <div style={{ padding: 40, fontFamily: FONT, color: C.textMuted }}>Loading plan…</div>;
  }

  const plans = (ent.catalog?.plans || []).slice().sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  const currentKey = ent.plan?.key;
  const currentMeta = currentKey ? PLAN_META[currentKey] : null;
  const currentTier = currentMeta?.tier ?? -1;
  const limits = ent.limits || {};
  const featureRows = orderedFeatures(ent.catalog);

  return (
    <div style={{ padding: '28px 32px 48px', fontFamily: FONT, color: C.text, maxWidth: 1180, margin: '0 auto', width: '100%' }}>
      <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.primary }}>
        Subscription
      </div>
      <h1 style={{ fontSize: 26, fontWeight: 800, margin: '0 0 22px', letterSpacing: '-0.02em' }}>Plan & Billing</h1>

      {/* Current plan banner */}
      {ent.isSuperAdmin ? (
        <div style={{ ...bannerStyle(C.primary), marginBottom: 28 }}>
          <div>
            <div style={{ fontSize: 12.5, color: C.textSecondary, fontWeight: 600 }}>Platform owner</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>All features unlocked</div>
          </div>
          <Crown size={28} color={C.primary} />
        </div>
      ) : currentMeta && (
        <div style={{ ...bannerStyle(currentMeta.accent), marginBottom: 22 }}>
          <div>
            <div style={{ fontSize: 12.5, color: C.textSecondary, fontWeight: 600, marginBottom: 2 }}>Current plan</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 24, fontWeight: 800 }}>{currentMeta.label}</span>
              {ent.status && (
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'capitalize', color: C.green, background: `${C.green}1a`, padding: '3px 10px', borderRadius: 20 }}>
                  {ent.status}
                </span>
              )}
            </div>
          </div>
          <span style={{ width: 46, height: 46, borderRadius: 12, background: `${currentMeta.accent}1f`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Crown size={24} color={currentMeta.accent} />
          </span>
        </div>
      )}

      {/* Subscription period / expiry state */}
      {!ent.isSuperAdmin && ent.subscription && (ent.subscription.expired || ent.subscription.periodEnd) && (() => {
        const s = ent.subscription;
        const accent = s.locked ? '#DC2626' : s.inGrace ? C.amber : C.green;
        const msg = s.locked
          ? 'Your subscription has expired and features are locked. Contact your account manager to renew.'
          : s.inGrace
            ? `Your plan expired and is in a grace period — features stay on for about ${Math.max(0, s.daysLeft ?? 0)} more day(s). Renew to avoid interruption.`
            : `Your plan renews on ${new Date(s.periodEnd).toLocaleDateString()}.`;
        return (
          <div style={{ ...bannerStyle(accent), marginBottom: 22 }}>
            <div>
              <div style={{ fontSize: 12.5, color: accent, fontWeight: 700, marginBottom: 2 }}>
                {s.locked ? 'Subscription expired' : s.inGrace ? 'Renewal due' : 'Billing'}
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{msg}</div>
            </div>
          </div>
        );
      })()}

      {/* Usage meters */}
      {!ent.isSuperAdmin && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 36 }}>
          <UsageMeter icon={Users}     label="Team members"  used={limits.users?.used}        max={limits.users?.max} />
          <UsageMeter icon={Building2} label="Organizations" used={limits.organizations?.used} max={limits.organizations?.max} />
          <UsageMeter icon={Contact}   label="Contacts"      used={limits.contacts?.used}      max={limits.contacts?.max} />
        </div>
      )}

      {/* A request already in flight. This is the whole feedback loop for the
          customer, so it says plainly what happens next. */}
      {request && (
        <div style={{ ...bannerStyle(C.amber), marginBottom: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Clock size={20} color={C.amber} />
            <div>
              <div style={{ fontSize: 12.5, color: C.amber, fontWeight: 700, marginBottom: 2 }}>Upgrade requested</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
                You asked to move to <strong>{request.planName}</strong> ({request.billingCycle}).
                We’ll be in touch to arrange payment and activate it.
              </div>
            </div>
          </div>
          {canBuy && (
            <button
              type="button"
              onClick={withdraw}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', borderRadius: 9, cursor: 'pointer',
                border: `1px solid ${C.border}`, background: C.cardBg,
                color: C.textSecondary, fontFamily: FONT, fontSize: 12.5, fontWeight: 600,
              }}
            >
              <X size={14} /> Withdraw
            </button>
          )}
        </div>
      )}

      {err && (
        <div role="alert" style={{
          background: C.primaryLight, color: '#DC2626', borderRadius: 10,
          padding: '10px 14px', fontSize: 13, marginBottom: 16, fontWeight: 500,
        }}>{err}</div>
      )}

      {/* Plan comparison */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <TrendingUp size={18} color={C.textSecondary} />
          <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0 }}>Compare plans</h2>
        </div>
        {canBuy && (
          <div role="group" aria-label="Billing cycle" style={{
            display: 'flex', gap: 3, padding: 3, marginLeft: 'auto',
            background: C.surfaceAlt, borderRadius: 9,
          }}>
            {[['monthly', 'Monthly'], ['yearly', 'Yearly · save 20%']].map(([key, label]) => {
              const active = cycle === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setCycle(key)}
                  style={{
                    padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer',
                    fontFamily: FONT, fontSize: 12, fontWeight: 700,
                    background: active ? C.cardBg : 'transparent',
                    color: active ? C.text : C.textSecondary,
                    boxShadow: active ? '0 1px 4px rgba(0,0,0,0.10)' : 'none',
                  }}
                >{label}</button>
              );
            })}
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
        {plans.map(p => {
          const m = PLAN_META[p.key] || { label: p.name, tier: 0, accent: C.textSecondary };
          const isCurrent = p.key === currentKey;
          const isUpgrade = !ent.isSuperAdmin && m.tier > currentTier;
          const yearlyTotal = Number(p.price_yearly);
          // price_yearly is the ANNUAL total; show it per-month so the two
          // cycles are comparable at a glance rather than 12x apart.
          const price = cycle === 'yearly' && yearlyTotal > 0
            ? yearlyTotal / 12
            : Number(p.price_monthly);
          const feats = Array.isArray(p.features) ? p.features : [];
          // Enterprise is priced on application — there's nothing to self-serve.
          const isCustomPriced = p.key === 'enterprise';
          const requested = request?.planKey === p.key;
          return (
            <div key={p.key} style={{
              position: 'relative', borderRadius: 18, padding: 22,
              background: isCurrent ? `linear-gradient(160deg, ${m.accent}14, ${C.cardBg} 60%)` : C.cardBg,
              border: `1.5px solid ${isCurrent ? m.accent : C.border}`,
              boxShadow: isCurrent ? `0 18px 50px ${m.accent}22` : C.shadowSm,
              transition: 'transform 0.18s ease, box-shadow 0.18s ease',
            }}
              onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.transform = 'translateY(-3px)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'none'; }}
            >
              {isCurrent && (
                <span style={{ position: 'absolute', top: 14, right: 14, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: m.accent, background: `${m.accent}1f`, padding: '4px 10px', borderRadius: 20 }}>
                  Current
                </span>
              )}
              <div style={{ fontSize: 16, fontWeight: 800, color: m.accent }}>{m.label}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, margin: '8px 0 4px' }}>
                <span style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em' }}>
                  {price === 0 ? (isCustomPriced ? 'Custom' : 'Free') : fmtMoney(Math.round(price), p.currency)}
                </span>
                {price > 0 && <span style={{ fontSize: 12.5, color: C.textMuted, fontWeight: 600 }}>/mo</span>}
              </div>
              <div style={{ fontSize: 12.5, color: C.textSecondary, minHeight: 34, lineHeight: 1.4 }}>{p.description}</div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '14px 0', fontSize: 12.5, color: C.textSecondary }}>
                <LimitRow label="Users" value={formatLimit(p.max_users)} />
                <LimitRow label="Organizations" value={formatLimit(p.max_organizations)} />
                <LimitRow label="Contacts" value={formatLimit(p.max_contacts)} />
              </div>

              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
                {featureRows.map(fk => {
                  const on = feats.includes(fk);
                  return (
                    <div key={fk} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: on ? C.text : C.textMuted, opacity: on ? 1 : 0.55 }}>
                      {on
                        ? <Check size={14} color={m.accent} strokeWidth={3} />
                        : <Minus size={14} color={C.textMuted} />}
                      {FEATURE_LABELS[fk] || fk}
                    </div>
                  );
                })}
              </div>

              {canBuy && !isCurrent && (
                isCustomPriced ? (
                  <div style={{ marginTop: 16, fontSize: 11.5, color: C.textMuted, textAlign: 'center', lineHeight: 1.5 }}>
                    Priced to fit — talk to us about Enterprise.
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={!!busy || requested}
                    onClick={() => choosePlan(p.key)}
                    style={{
                      width: '100%', marginTop: 16, padding: '11px', borderRadius: 10,
                      border: requested ? `1.5px solid ${C.border}` : 'none',
                      background: requested ? C.cardBg : m.accent,
                      color: requested ? C.textSecondary : '#fff',
                      fontSize: 13.5, fontWeight: 700, fontFamily: FONT,
                      cursor: (busy || requested) ? 'default' : 'pointer',
                      opacity: busy === p.key ? 0.7 : 1,
                    }}
                  >
                    {requested
                      ? 'Requested'
                      : busy === p.key
                        ? 'Sending…'
                        : isUpgrade ? `Upgrade to ${m.label}` : `Switch to ${m.label}`}
                  </button>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function bannerStyle(accent) {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '20px 24px', borderRadius: 18,
    background: `linear-gradient(135deg, ${accent}12, ${C.cardBg})`,
    border: `1px solid ${accent}33`, boxShadow: C.shadowSm,
  };
}

function LimitRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span>{label}</span>
      <span style={{ fontWeight: 700, color: C.text }}>{value}</span>
    </div>
  );
}
