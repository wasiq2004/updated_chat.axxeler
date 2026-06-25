import { useState, useRef, useEffect } from 'react';
import { Info, LogOut, Settings, AlertTriangle, CreditCard, ScrollText, Palette, Building2 } from 'lucide-react';
import { C, FONT } from '../constants.js';
import { api } from '../api.js';
import OrgSwitcher from './OrgSwitcher.jsx';

export default function Topbar({ user, onLogout, onNavigate, orgs, activeOrg, onOrgChange, branding }) {
  const isAdmin = user?.role === 'admin';
  const logoSrc = branding?.logoUrl || '/logo.png';
  const brandName = branding?.brandName || 'Zen Chat';
  const [userOpen, setUserOpen] = useState(false);
  const [unhealthyAccounts, setUnhealthyAccounts] = useState([]);
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setUserOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Poll account health every 60s so the banner appears within a minute
  // of Meta rejecting a token. Cleared instantly when token is updated.
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api.whatsappAccounts.list()
        .then(accs => { if (!cancelled) setUnhealthyAccounts(accs.filter(a => a.healthStatus === 'invalid_token')); })
        .catch(() => {});
    };
    check();
    const t = setInterval(check, 60000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <>
    {unhealthyAccounts.length > 0 && (
      <div
        onClick={() => onNavigate('admin-settings')}
        style={{
          background: 'linear-gradient(135deg, #E22635, #FF4D5A)', color: '#fff', padding: '8px 16px',
          fontSize: 12, fontFamily: FONT, display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 8, cursor: 'pointer', fontWeight: 500,
          animation: 'fadeInDown 0.3s ease-out both',
        }}
      >
        <AlertTriangle size={14} />
        <span>
          Access token expired for {unhealthyAccounts.map(a => a.displayName).join(', ')} — click to update in Settings → WhatsApp Accounts
        </span>
      </div>
    )}
    <div style={{
      height: 56,
      background: 'linear-gradient(180deg, rgba(0,0,0,.055), rgba(0,0,0,.015)), var(--c-headerBg)',
      backdropFilter: 'blur(18px)',
      WebkitBackdropFilter: 'blur(18px)',
      display: 'flex',
      alignItems: 'center',
      paddingLeft: 0,
      paddingRight: 20,
      borderBottom: `1px solid ${C.headerBorder}`,
      flexShrink: 0,
      zIndex: 100,
      position: 'relative',
      boxShadow: '0 1px 0 rgba(0,0,0,.04), 0 16px 40px rgba(0,0,0,.24)',
    }}>
      {/* Logo area — aligns with sidebar */}
      <button
        onClick={() => onNavigate('chats')}
        style={{
          width: 224,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingLeft: 15,
          paddingRight: 15,
          borderRight: `1px solid ${C.headerBorder}`,
          height: '100%',
          background: 'transparent',
          border: 'none',
          borderRightWidth: 1,
          borderRightStyle: 'solid',
          cursor: 'pointer',
        }}
      >
        <img
          src={logoSrc}
          alt={brandName}
          style={{ height: 34, width: 'auto', maxWidth: 180, objectFit: 'contain', display: 'block' }}
        />
      </button>

      {/* Organization switcher (multi-org tenants) */}
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: 16 }}>
        <OrgSwitcher
          orgs={orgs}
          activeOrg={activeOrg}
          onOrgChange={onOrgChange}
          onManage={() => onNavigate('organizations')}
        />
      </div>

      <div style={{ flex: 1 }} />

      {/* Right controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* About Us */}
        <button
          onClick={() => onNavigate('about')}
          title="About Us"
          style={{
            width: 36, height: 36, borderRadius: 9,
            background: C.headerSurface, border: `1px solid ${C.headerBorder}`,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.12)'; e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 10px 24px rgba(0,0,0,.24)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = C.headerSurface; e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
        >
          <Info size={16} color={C.headerText} />
        </button>

        {/* User avatar */}
        <div ref={ref} style={{ position: 'relative' }}>
          <button
            onClick={() => setUserOpen(p => !p)}
            style={{
              width: 36,
              height: 36,
              borderRadius: 9,
              background: 'linear-gradient(135deg, #E22635, #FF4D5A)',
              border: userOpen ? '2px solid #fff' : `1px solid ${C.headerBorder}`,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
              fontWeight: 700,
              color: '#fff',
              fontFamily: FONT,
              transition: 'border .15s',
              padding: 0,
              overflow: 'hidden',
            }}
          >
            {(user.displayName || user.username).charAt(0).toUpperCase()}
          </button>

          {userOpen && (
            <div style={{
              position: 'absolute', top: 44, right: 0,
              background: 'linear-gradient(180deg, rgba(0,0,0,.06), rgba(0,0,0,.02)), var(--c-cardBg)', border: `1px solid ${C.border}`,
              borderRadius: 18, boxShadow: C.shadowLg,
              padding: 6, minWidth: 200, zIndex: 200,
              animation: 'scaleInFast 0.18s cubic-bezier(0.16,1,0.3,1) both',
              transformOrigin: 'top right',
            }}>
              <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, letterSpacing: '-0.01em' }}>
                  {user.displayName || user.username}
                </div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2, fontWeight: 500 }}>
                  Owner
                </div>
              </div>
              {[
                { label: 'Plan & billing', icon: <CreditCard size={14} />, action: () => { setUserOpen(false); onNavigate('billing'); }, color: C.text },
                ...(isAdmin ? [
                  { label: 'Organizations', icon: <Building2 size={14} />, action: () => { setUserOpen(false); onNavigate('organizations'); }, color: C.text },
                  { label: 'White-label',   icon: <Palette size={14} />,   action: () => { setUserOpen(false); onNavigate('branding'); },      color: C.text },
                  { label: 'Audit log',     icon: <ScrollText size={14} />, action: () => { setUserOpen(false); onNavigate('audit'); },         color: C.text },
                ] : []),
                { label: 'Settings', icon: <Settings size={14} />, action: () => { setUserOpen(false); onNavigate('admin-settings'); }, color: C.text },
                { label: 'Sign out',  icon: <LogOut size={14} />,   action: () => { setUserOpen(false); onLogout(); },                  color: C.primaryHover },
              ].map(({ label, icon, action, color }) => (
                <button key={label} onClick={action} style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 9,
                  padding: '9px 14px', borderRadius: 7, background: 'transparent',
                  border: 'none', cursor: 'pointer', color, fontSize: 13,
                  fontWeight: 600, fontFamily: FONT,
                  transition: 'background 0.12s ease',
                }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,.06)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {icon}{label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
