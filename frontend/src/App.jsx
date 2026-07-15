import { useState, useEffect } from 'react';
import { api, setActiveOrg, getActiveOrg } from './api.js';
import { C, FONT } from './constants.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import LoginGate from './components/LoginGate.jsx';
import LandingPage from './pages/LandingPage.jsx';
import SetupWizard from './components/SetupWizard.jsx';
import Topbar from './components/Topbar.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatsPage from './components/ChatsPage.jsx';
import HomePage from './pages/HomePage.jsx';
import ChatbotBuilderPage from './pages/ChatbotBuilderPage.jsx';
import TemplateBuilderPage from './pages/TemplateBuilderPage.jsx';
import ContactsPage from './pages/ContactsPage.jsx';
import BulkMessagePage from './pages/BulkMessagePage.jsx';
import AdminSettingsPage from './pages/AdminSettingsPage.jsx';
import MediaLibraryPage from './pages/MediaLibraryPage.jsx';
// import AboutUsPage from './pages/AboutUsPage.jsx';  // About Us hidden
import PipelinesPage from './pages/PipelinesPage.jsx';
import FollowUpSequencePage from './pages/FollowUpSequencePage.jsx';
import AiAgentBuilderPage from './pages/AiAgentBuilderPage.jsx';
import { PrivacyPolicyPage, TermsPage } from './pages/LegalPages.jsx';
import SuperAdminPage from './pages/SuperAdminPage.jsx';
import BillingPage from './pages/BillingPage.jsx';
import OrganizationsPage from './pages/OrganizationsPage.jsx';
import BrandingPage from './pages/BrandingPage.jsx';
import AuditPage from './pages/AuditPage.jsx';
import UpgradeGate from './components/UpgradeGate.jsx';
import RenewGate from './components/RenewGate.jsx';
import ResetPasswordGate from './components/ResetPasswordGate.jsx';
import AccountSecurityModal from './components/AccountSecurityModal.jsx';
import ConnectWhatsAppModal from './components/ConnectWhatsAppModal.jsx';
import { canAccessPage } from './lib/plans.js';
import { getFacebookConfig } from './lib/facebook.js';

// White-label: a partner's customers arrive at ?w=<slug> for their branded
// login. They must never see our own marketing page. (Mirrors the same read in
// LoginGate, which uses the slug to fetch the partner's branding.)
function readPartnerSlug() {
  try {
    const fromSearch = new URLSearchParams(window.location.search).get('w');
    if (fromSearch) return fromSearch;
    const h = window.location.hash || '';
    const qi = h.indexOf('?');
    if (qi >= 0) return new URLSearchParams(h.slice(qi + 1)).get('w');
  } catch { /* ignore */ }
  return null;
}

const VALID_PAGES = new Set([
  'home', 'chatbot-builder', 'template-builder', 'chats',
  'contacts', 'pipelines', 'bulk-message', 'admin-settings', 'media-library',
  'ai-agent-builder', 'follow-ups', 'super-admin', 'billing', 'organizations', 'branding', 'audit',
]);

export default function App() {
  const [user, setUser] = useState(null);
  const [entitlements, setEntitlements] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [activeOrg, setActiveOrgState] = useState(getActiveOrg());
  const [checking, setChecking] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);
  // Logged-out visitors see the marketing page first. `#/login` (or a bookmark
  // to it) opens the login form straight away, and a white-label partner link
  // (?w=<slug>) always goes straight to that partner's branded login.
  const partnerSlug = readPartnerSlug();
  const [showLogin, setShowLogin] = useState(() => {
    try { return /#\/?(login|signup)\b/.test(window.location.hash || ''); } catch { return false; }
  });
  // Which face of the login screen to open on. The landing page's "Start Free"
  // means "create an account", so it must not drop people on a sign-in form they
  // have no credentials for.
  const [authMode, setAuthMode] = useState(() => {
    try { return /#\/?signup\b/.test(window.location.hash || '') ? 'signup' : 'signin'; } catch { return 'signin'; }
  });
  // ?verify=<token> — the link from the confirmation email. Held in state so the
  // token can be stripped from the URL immediately after it's consumed (it is
  // single-use, and it should not sit in history or a shared screenshot).
  const [verifyToken, setVerifyToken] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('verify'); } catch { return null; }
  });
  const [verifyState, setVerifyState] = useState(null); // null | 'working' | 'failed'
  // ?reset=<token> — the link from the forgot-password email. Read once at mount
  // and held in state; the token is stripped from the URL as soon as it's used.
  const [resetToken, setResetToken] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('reset'); } catch { return null; }
  });
  const [routeParts, navigate, replaceRoute] = useHashRoute();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Light/dark theme. Initialized from the data-theme the no-flash boot script in
  // index.html already set (saved choice or system preference).
  const [theme, setTheme] = useState(() =>
    (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme')) === 'dark' ? 'dark' : 'light');
  const toggleTheme = () => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      document.documentElement.style.colorScheme = next;
      try { localStorage.setItem('zc-theme', next); } catch { /* ignore */ }
      return next;
    });
  };

  const page = VALID_PAGES.has(routeParts[0]) ? routeParts[0] : 'home';
  const subParts = routeParts.slice(1);
  const setPage = (p) => navigate(p);

  // Normalize empty hash to #/home so reload always shows a valid URL
  useEffect(() => {
    if (!routeParts[0]) replaceRoute('home');
  }, [routeParts, replaceRoute]);

  // The platform/reseller console is for the platform owner OR a white-label
  // reseller admin — redirect anyone else away from it.
  const isConsoleUser = !!(user && (user.isSuperAdmin || user.isResellerAdmin));
  useEffect(() => {
    if (user && page === 'super-admin' && !isConsoleUser) setPage('home');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, user]);

  // Post-login nudge: a tenant admin who hasn't connected a WhatsApp number yet
  // is invited to connect it via Facebook (Embedded Signup). Only when a Meta app
  // is configured, and only once per browser session (not on every reload).
  const [showAccount, setShowAccount] = useState(false);
  const [showConnectWa, setShowConnectWa] = useState(false);
  useEffect(() => {
    if (!user || user.role !== 'admin' || isConsoleUser) { setShowConnectWa(false); return; }
    let seen = false;
    try { seen = sessionStorage.getItem('zc_fb_connect_seen') === '1'; } catch { /* ignore */ }
    if (seen) return;
    let alive = true;
    (async () => {
      const cfg = await getFacebookConfig().catch(() => null);
      if (!alive || !cfg?.enabled) return;
      // Only nudge when we can POSITIVELY confirm the tenant has zero connected
      // numbers. If the lookup fails, stay silent rather than risk showing the
      // popup to someone who has already connected WhatsApp.
      let accounts;
      try {
        accounts = await api.whatsappAccounts.list();
      } catch {
        return;
      }
      if (alive && Array.isArray(accounts) && accounts.length === 0) setShowConnectWa(true);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isConsoleUser]);

  const dismissConnectWa = () => {
    try { sessionStorage.setItem('zc_fb_connect_seen', '1'); } catch { /* ignore */ }
    setShowConnectWa(false);
  };

  // Console operators (platform owner & resellers) have NO operational workspace —
  // they only monitor/configure. Keep them inside the console; to actually work
  // inside an admin's workspace they impersonate (which clears these flags).
  useEffect(() => {
    if (isConsoleUser && !user.impersonation && page !== 'super-admin') setPage('super-admin');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, user]);

  // Page guard: non-admins can only reach pages granted to them (user.pages).
  // admin-settings is allowed if they have any admin-settings:* sub-page.
  useEffect(() => {
    if (!user || user.role === 'admin' || !Array.isArray(user.pages)) return;
    if (page === 'super-admin') return; // handled by the platform guard above
    const allowed = page === 'admin-settings'
      ? user.pages.some(p => p.startsWith('admin-settings'))
      : user.pages.includes(page);
    if (!allowed) setPage('home');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, user]);

  const stopImpersonation = async () => {
    try { await api.stopImpersonation(); } catch { /* ignore */ }
    try {
      const { user: u } = await api.auth.me();
      setUser(u);
    } catch { setUser(null); }
    setPage('home');
  };

  useEffect(() => {
    // Collapse main sidebar by default on automation builder page
    if (page === 'chatbot-builder') {
      setSidebarCollapsed(true);
    }
  }, [page]);

  // Load the tenant's plan entitlements (features/limits/usage) whenever the
  // signed-in user changes, so the UI can gate premium pages + show usage.
  const loadEntitlements = () => api.billing.entitlements().then(setEntitlements).catch(() => setEntitlements(null));
  useEffect(() => {
    if (!user) { setEntitlements(null); return; }
    loadEntitlements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Apply white-label branding (accent color) from the tenant's plan. Overrides
  // the CSS theme variable so buttons/highlights re-skin instantly; cleared when
  // there's no custom color so the default brand cyan returns.
  useEffect(() => {
    const root = document.documentElement;
    const color = entitlements?.branding?.primaryColor;
    if (color) {
      root.style.setProperty('--c-primary', color);
      root.style.setProperty('--c-primaryHover', color);
      root.style.setProperty('--c-primaryLight', `${color}24`);
    } else {
      root.style.removeProperty('--c-primary');
      root.style.removeProperty('--c-primaryHover');
      root.style.removeProperty('--c-primaryLight');
    }
  }, [entitlements]);

  // Load the tenant's organizations (for the org switcher). Best-effort — a user
  // without org-view permission simply gets no switcher.
  const loadOrgs = () => api.organizations.list().then(setOrgs).catch(() => setOrgs([]));
  useEffect(() => {
    if (!user) { setOrgs([]); return; }
    loadOrgs();
  }, [user]);

  // Switch the active organization: persist the X-Organization-Id header and
  // remount the page so its data re-fetches for the selected org.
  const changeOrg = (id) => {
    setActiveOrg(id);
    setActiveOrgState(id ? String(id) : null);
  };

  useEffect(() => {
    // Arriving on a ?verify= or ?reset= link: those flows own the session.
    // Skipping the normal check here is not an optimisation — both run
    // concurrently, and there is no cookie yet, so /auth/me 401s and its
    // `.catch(() => setUser(null))` would race the verified user right back out
    // and dump a just-confirmed person on the login screen.
    if (verifyToken || resetToken) { setChecking(false); return; }
    // First check whether the instance needs first-run setup (no users yet).
    // If so, show the setup wizard; otherwise resume the normal session check.
    api.auth.status()
      .then(({ setupRequired: needed }) => {
        if (needed) { setSetupRequired(true); setChecking(false); return null; }
        return api.auth.me()
          .then(({ user }) => setUser(user))
          .catch(() => setUser(null))
          .finally(() => setChecking(false));
      })
      .catch(() => {
        // status unavailable (DB warming) — fall back to a normal session check.
        api.auth.me()
          .then(({ user }) => setUser(user))
          .catch(() => setUser(null))
          .finally(() => setChecking(false));
      });
  }, []);

  // Consume the ?verify=<token> link from the confirmation email. On success the
  // server issues the session cookie, so this both verifies and signs in — the
  // person clicks the link and is simply inside their new workspace.
  useEffect(() => {
    if (!verifyToken) return;
    let alive = true;
    setVerifyState('working');
    api.auth.verifyEmail(verifyToken)
      .then(({ user: u }) => { if (alive) { setUser(u); setVerifyState(null); setShowLogin(true); } })
      .catch(() => { if (alive) setVerifyState('failed'); })
      .finally(() => {
        if (!alive) return;
        setVerifyToken(null);
        // Strip the single-use token from the address bar so a reload doesn't
        // retry a spent token and show a false "link expired".
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete('verify');
          window.history.replaceState({}, '', url.toString());
        } catch { /* ignore */ }
      });
    return () => { alive = false; };
  }, [verifyToken]);

  const handleLogout = async () => {
    await api.auth.logout().catch(() => {});
    setUser(null);
    setPage('home');
  };

  // Public legal pages live at clean paths (so they can be submitted to Meta)
  // and must render whether or not the visitor is logged in, without waiting on
  // the auth-status check.
  const publicPath = typeof window !== 'undefined' ? window.location.pathname : '/';
  if (publicPath === '/privacy-policy') return <PrivacyPolicyPage />;
  if (publicPath === '/terms-and-conditions') return <TermsPage />;

  if (checking || verifyState === 'working') {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT, background: C.pageBg, flexDirection: 'column', gap: 14,
      }}>
        <span style={{
          display: 'inline-block', width: 28, height: 28,
          border: `3px solid ${C.border}`, borderTopColor: 'var(--c-primary)',
          borderRadius: '50%', animation: 'spin 0.75s linear infinite',
        }} />
        <div style={{ fontSize: 12, color: C.textSecondary, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {verifyState === 'working' ? 'Confirming your email…' : 'Loading...'}
        </div>
      </div>
    );
  }

  // A spent or expired confirmation link. Dead-ends into an explanation with a
  // way out, rather than silently dropping them on a login they'd fail.
  if (!user && verifyState === 'failed') {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT, background: C.pageBg, padding: 24,
      }}>
        <div style={{
          maxWidth: 420, textAlign: 'center', background: C.cardBg,
          border: `1px solid ${C.border}`, borderRadius: 14, padding: '32px 28px',
        }}>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 10, letterSpacing: '-0.02em' }}>
            This link has expired
          </h2>
          <p style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.6, marginBottom: 22 }}>
            Confirmation links last 24 hours and can only be used once. Sign in to
            have a new one sent, or create your account again.
          </p>
          <button
            type="button"
            onClick={() => { setVerifyState(null); setAuthMode('signin'); setShowLogin(true); }}
            style={{
              padding: '11px 22px', borderRadius: 10, border: 'none', background: C.primary,
              color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: FONT,
            }}
          >
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  if (setupRequired && !user) {
    return <SetupWizard onComplete={(u) => { setSetupRequired(false); setUser(u); }} />;
  }

  // ?reset=<token> — choose a new password, then straight into the app.
  if (!user && resetToken) {
    return (
      <ResetPasswordGate
        token={resetToken}
        onDone={(u) => {
          setResetToken(null);
          try {
            const url = new URL(window.location.href);
            url.searchParams.delete('reset');
            window.history.replaceState({}, '', url.toString());
          } catch { /* ignore */ }
          setUser(u);
          navigate('home');
        }}
        onExpired={() => {
          setResetToken(null);
          setAuthMode('signin');
          setShowLogin(true);
        }}
      />
    );
  }

  if (!user) {
    // Logged-out visitors land on the marketing page first; "Start Free" / "Log
    // in" take them to the login screen, which can come back via "Back to home".
    // A white-label partner link (?w=<slug>) is a customer's branded login — skip
    // our marketing page and show their login directly.
    if (!showLogin && !partnerSlug) {
      return (
        <LandingPage
          // "Start Free" opens the signup form; "Log in" opens sign-in. The
          // landing page tells us which was clicked.
          onGetStarted={(intent) => { setAuthMode(intent === 'login' ? 'signin' : 'signup'); setShowLogin(true); }}
          onNavigate={(path) => { window.location.href = path; }}
        />
      );
    }
    return (
      <LoginGate
        initialMode={authMode}
        onLogin={(u) => { setUser(u); navigate('home'); }}
        onBack={partnerSlug ? undefined : () => setShowLogin(false)}
      />
    );
  }

  const renderPage = () => {
    // Subscription expired past its grace window → hard-lock the app behind a
    // renew prompt. Billing stays reachable so they can review their plan. The
    // backend also denies features when locked (entitlements.js), so this is the
    // matching UX, not the enforcement.
    if (entitlements?.subscription?.locked === true && page !== 'billing') {
      return <RenewGate onViewBilling={() => setPage('billing')} />;
    }
    // Plan feature gate: premium pages render the upgrade screen when the
    // tenant's plan doesn't include the feature (backend also enforces it).
    if (!canAccessPage(entitlements, page)) {
      return <UpgradeGate pageId={page} entitlements={entitlements} onViewPlans={() => setPage('billing')} />;
    }
    switch (page) {
      case 'home': return <HomePage user={user} onPageChange={setPage} />;
      case 'chats': return <ChatsPage subParts={subParts} navigate={navigate} user={user} />;
      case 'contacts': return <ContactsPage user={user} onNavigate={navigate} />;
      case 'pipelines': return <PipelinesPage user={user} />;
      case 'follow-ups': return <FollowUpSequencePage />;
      case 'template-builder': return <TemplateBuilderPage subParts={subParts} navigate={navigate} />;
      case 'media-library': return <MediaLibraryPage />;
      case 'bulk-message': return <BulkMessagePage onNavigate={navigate} />;
      case 'chatbot-builder': return <ChatbotBuilderPage subParts={subParts} navigate={navigate} />;
      case 'ai-agent-builder': return <AiAgentBuilderPage user={user} navigate={navigate} />;
      // case 'about': return <AboutUsPage />;  // About Us hidden
      case 'billing': return <BillingPage entitlements={entitlements} user={user} />;
      case 'organizations': return <OrganizationsPage onOrgsChanged={loadOrgs} activeOrg={activeOrg} />;
      case 'branding': return <BrandingPage onSaved={loadEntitlements} managedByReseller={entitlements?.brandingManagedByReseller} />;
      case 'audit': return <AuditPage />;
      case 'admin-settings': return <AdminSettingsPage onLogout={handleLogout} onNavigate={setPage} subParts={subParts} navigate={navigate} user={user} />;
      case 'super-admin': return isConsoleUser ? <SuperAdminPage user={user} /> : <HomePage user={user} onPageChange={setPage} />;
      default: return <HomePage user={user} onPageChange={setPage} />;
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      fontFamily: FONT,
      background: C.pageBg,
      color: C.text,
    }}>
      {user.impersonation && (
        <div style={{
          background: '#B45309', color: '#fff', fontFamily: FONT, fontSize: 13, fontWeight: 600,
          padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
        }}>
          <span>⚠ You are impersonating <b>{user.displayName || user.username}</b> (started by {user.impersonation.by}).</span>
          <button onClick={stopImpersonation} style={{
            background: '#fff', color: '#B45309', border: 'none', borderRadius: 6,
            padding: '4px 12px', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', fontFamily: FONT,
          }}>Stop impersonating</button>
        </div>
      )}
      {entitlements?.subscription?.inGrace === true && (
        <div style={{
          background: '#B45309', color: '#fff', fontFamily: FONT, fontSize: 13, fontWeight: 600,
          padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
        }}>
          <span>
            ⚠ Your plan has expired — features stay on for {Math.max(0, entitlements.subscription.daysLeft ?? 0)} more day(s). Renew to avoid interruption.
          </span>
          <button onClick={() => setPage('billing')} style={{
            background: '#fff', color: '#B45309', border: 'none', borderRadius: 6,
            padding: '4px 12px', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', fontFamily: FONT,
          }}>View billing</button>
        </div>
      )}
      <Topbar
        user={user}
        onLogout={handleLogout}
        onNavigate={setPage}
        onOpenAccount={() => setShowAccount(true)}
        orgs={orgs}
        activeOrg={activeOrg}
        onOrgChange={changeOrg}
        branding={entitlements?.branding}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {page !== 'admin-settings' && page !== 'super-admin' && (
          <Sidebar
            activePage={page}
            onPageChange={setPage}
            collapsed={sidebarCollapsed}
            setCollapsed={setSidebarCollapsed}
            user={user}
            entitlements={entitlements}
          />
        )}
        <div key={`${page}:${activeOrg || 'all'}`} className="page-enter" style={{
          flex: 1,
          overflow: 'auto',
          background: 'linear-gradient(180deg, rgba(0,0,0,.025), rgba(0,0,0,0) 180px), var(--c-pageBg)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          {renderPage()}
        </div>
      </div>
      {showConnectWa && (
        <ConnectWhatsAppModal
          onClose={dismissConnectWa}
          onConnected={dismissConnectWa}
        />
      )}
      {showAccount && (
        <AccountSecurityModal
          user={user}
          onClose={() => setShowAccount(false)}
          // Re-read the session so passwordSet / facebookLinked reflect what just
          // changed — the modal renders "set" vs "change" off those, and would
          // otherwise keep showing the stale state until the next reload.
          onChanged={() => api.auth.me().then(({ user: u }) => setUser(u)).catch(() => {})}
        />
      )}
    </div>
  );
}
