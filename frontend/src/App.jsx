import { useState, useEffect } from 'react';
import { api, setActiveOrg, getActiveOrg } from './api.js';
import { C, FONT } from './constants.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import LoginGate from './components/LoginGate.jsx';
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
import AboutUsPage from './pages/AboutUsPage.jsx';
import PipelinesPage from './pages/PipelinesPage.jsx';
import AiAgentBuilderPage from './pages/AiAgentBuilderPage.jsx';
import LandingPage from './pages/LandingPage.jsx';
import { PrivacyPolicyPage, TermsPage } from './pages/LegalPages.jsx';
import SuperAdminPage from './pages/SuperAdminPage.jsx';
import BillingPage from './pages/BillingPage.jsx';
import OrganizationsPage from './pages/OrganizationsPage.jsx';
import BrandingPage from './pages/BrandingPage.jsx';
import AuditPage from './pages/AuditPage.jsx';
import UpgradeGate from './components/UpgradeGate.jsx';
import { canAccessPage } from './lib/plans.js';

const VALID_PAGES = new Set([
  'home', 'chatbot-builder', 'template-builder', 'chats',
  'contacts', 'pipelines', 'bulk-message', 'admin-settings', 'media-library', 'about',
  'ai-agent-builder', 'super-admin', 'billing', 'organizations', 'branding', 'audit',
]);

export default function App() {
  const [user, setUser] = useState(null);
  const [entitlements, setEntitlements] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [activeOrg, setActiveOrgState] = useState(getActiveOrg());
  const [checking, setChecking] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);
  const [routeParts, navigate, replaceRoute] = useHashRoute();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const page = VALID_PAGES.has(routeParts[0]) ? routeParts[0] : 'home';
  const subParts = routeParts.slice(1);
  const setPage = (p) => navigate(p);

  // Normalize empty hash to #/home so reload always shows a valid URL
  useEffect(() => {
    if (!routeParts[0]) replaceRoute('home');
  }, [routeParts, replaceRoute]);

  // Super Admin console is platform-only: redirect anyone else away from it.
  useEffect(() => {
    if (user && page === 'super-admin' && !user.isSuperAdmin) setPage('home');
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
  // there's no custom color so the default red returns.
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

  if (checking) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT, background: C.pageBg, flexDirection: 'column', gap: 14,
      }}>
        <span style={{
          display: 'inline-block', width: 28, height: 28,
          border: `3px solid ${C.border}`, borderTopColor: '#E22635',
          borderRadius: '50%', animation: 'spin 0.75s linear infinite',
        }} />
        <div style={{ fontSize: 12, color: C.textSecondary, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Loading...</div>
      </div>
    );
  }

  if (setupRequired && !user) {
    return <SetupWizard onComplete={(u) => { setSetupRequired(false); setUser(u); }} />;
  }

  if (!user) {
    // Public marketing site for logged-out visitors. The landing page is the
    // default; the login form lives at #/login (reached via the top-bar button).
    if (routeParts[0] === 'login') {
      return (
        <LoginGate
          onLogin={(u) => { setUser(u); navigate('home'); }}
          onBack={() => navigate('home')}
        />
      );
    }
    return <LandingPage onLogin={() => navigate('login')} />;
  }

  const renderPage = () => {
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
      case 'template-builder': return <TemplateBuilderPage subParts={subParts} navigate={navigate} />;
      case 'media-library': return <MediaLibraryPage />;
      case 'bulk-message': return <BulkMessagePage onNavigate={navigate} />;
      case 'chatbot-builder': return <ChatbotBuilderPage subParts={subParts} navigate={navigate} />;
      case 'ai-agent-builder': return <AiAgentBuilderPage user={user} navigate={navigate} />;
      case 'about': return <AboutUsPage />;
      case 'billing': return <BillingPage entitlements={entitlements} />;
      case 'organizations': return <OrganizationsPage onOrgsChanged={loadOrgs} activeOrg={activeOrg} />;
      case 'branding': return <BrandingPage onSaved={loadEntitlements} />;
      case 'audit': return <AuditPage />;
      case 'admin-settings': return <AdminSettingsPage onLogout={handleLogout} onNavigate={setPage} subParts={subParts} navigate={navigate} user={user} />;
      case 'super-admin': return user.isSuperAdmin ? <SuperAdminPage /> : <HomePage user={user} onPageChange={setPage} />;
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
      {user.isSuperAdmin && !user.impersonation && page !== 'super-admin' && (
        <div style={{
          background: C.text, color: C.pageBg, fontFamily: FONT, fontSize: 12.5, fontWeight: 600,
          padding: '6px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        }}>
          <span>Platform owner mode</span>
          <button onClick={() => setPage('super-admin')} style={{
            background: 'transparent', color: C.pageBg, border: `1px solid ${C.pageBg}`, borderRadius: 6,
            padding: '3px 10px', fontWeight: 700, fontSize: 12, cursor: 'pointer', fontFamily: FONT,
          }}>Open Super Admin console</button>
        </div>
      )}
      <Topbar
        user={user}
        onLogout={handleLogout}
        onNavigate={setPage}
        orgs={orgs}
        activeOrg={activeOrg}
        onOrgChange={changeOrg}
        branding={entitlements?.branding}
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
    </div>
  );
}
