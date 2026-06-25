// Organization switcher (SaaS Phase 5). Lets a tenant user focus the app on one
// organization (sets X-Organization-Id via api.setActiveOrg) or view all. Only
// shown when the tenant has more than one organization.

import { useState, useRef, useEffect } from 'react';
import { Building2, Check, ChevronDown, Layers, Settings2 } from 'lucide-react';
import { C, FONT } from '../constants.js';

export default function OrgSwitcher({ orgs, activeOrg, onOrgChange, onManage }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  if (!Array.isArray(orgs) || orgs.length < 2) return null;

  const current = activeOrg ? orgs.find(o => String(o.id) === String(activeOrg)) : null;
  const label = current ? current.name : 'All organizations';

  const select = (id) => { setOpen(false); onOrgChange(id); };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(p => !p)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, maxWidth: 240,
          height: 36, padding: '0 12px', borderRadius: 9,
          background: C.headerSurface, border: `1px solid ${open ? C.primary : C.headerBorder}`,
          cursor: 'pointer', fontFamily: FONT, color: C.headerText,
          transition: 'border .15s, background .15s',
        }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = 'rgba(0,0,0,0.12)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = C.headerSurface; }}
      >
        <span style={{ width: 22, height: 22, borderRadius: 6, background: current ? `${C.primary}22` : 'rgba(255,255,255,.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {current ? <Building2 size={13} color={C.primary} /> : <Layers size={13} color={C.headerMuted} />}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <ChevronDown size={15} color={C.headerMuted} style={{ flexShrink: 0, transition: 'transform .18s', transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 44, left: 0, minWidth: 260,
          background: 'linear-gradient(180deg, rgba(0,0,0,.06), rgba(0,0,0,.02)), var(--c-cardBg)',
          border: `1px solid ${C.border}`, borderRadius: 16, boxShadow: C.shadowLg,
          padding: 6, zIndex: 200,
          animation: 'scaleInFast 0.16s cubic-bezier(0.16,1,0.3,1) both', transformOrigin: 'top left',
        }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: C.textMuted, padding: '8px 12px 6px' }}>
            Organization
          </div>
          <Row icon={<Layers size={15} />} label="All organizations" active={!activeOrg} onClick={() => select(null)} />
          <div style={{ height: 1, background: C.border, margin: '5px 8px' }} />
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {orgs.map(o => (
              <Row key={o.id}
                icon={<Building2 size={15} />}
                label={o.name}
                sub={o.members != null ? `${o.members} member${o.members === 1 ? '' : 's'}` : null}
                active={String(activeOrg) === String(o.id)}
                onClick={() => select(o.id)}
              />
            ))}
          </div>
          {onManage && (
            <>
              <div style={{ height: 1, background: C.border, margin: '5px 8px' }} />
              <Row icon={<Settings2 size={15} />} label="Manage organizations" onClick={() => { setOpen(false); onManage(); }} muted />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ icon, label, sub, active, onClick, muted }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 10,
      padding: '9px 12px', borderRadius: 9, background: active ? C.primaryLight : 'transparent',
      border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: FONT,
      color: muted ? C.textSecondary : C.text, transition: 'background .12s',
    }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(0,0,0,.06)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = active ? C.primaryLight : 'transparent'; }}
    >
      <span style={{ color: active ? C.primary : C.textMuted, display: 'flex', flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {sub && <span style={{ display: 'block', fontSize: 11, color: C.textMuted }}>{sub}</span>}
      </span>
      {active && <Check size={15} color={C.primary} style={{ flexShrink: 0 }} />}
    </button>
  );
}
