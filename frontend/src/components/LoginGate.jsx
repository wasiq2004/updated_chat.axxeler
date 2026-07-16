import { useState, useEffect } from 'react';
import { Lock, LogIn, Eye, EyeOff, ArrowLeft, UserPlus, MailCheck, AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';
import { loadFacebookSdk, fbLogin } from '../lib/facebook.js';

// White-label: read the partner slug from ?w=<slug> (search or hash query) so a
// partner's customers see branded login on the shared domain.
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

// `mode` is 'signin' | 'signup' | 'sent'. 'sent' is only reachable when the
// server has a mailer: with no SMTP configured, signup returns a session and we
// go straight into the app (see services/emailVerification on the backend).
export default function LoginGate({ onLogin, onBack, initialMode = 'signin' }) {
  const [mode, setMode] = useState(initialMode === 'signup' ? 'signup' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sendFailed, setSendFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [brand, setBrand] = useState(null); // partner white-label branding
  const [fbEnabled, setFbEnabled] = useState(false);
  const [fbLoading, setFbLoading] = useState(false);

  const partnerSlug = readPartnerSlug();
  const isSignup = mode === 'signup';

  useEffect(() => {
    if (!partnerSlug) return;
    api.brandingBySlug(partnerSlug).then(b => { if (b?.found) setBrand(b); }).catch(() => {});
  }, [partnerSlug]);

  // Show the "Sign in with Facebook" button only when the server has a Meta app
  // configured. Preload the SDK so the click is instant.
  useEffect(() => {
    let alive = true;
    loadFacebookSdk().then(cfg => { if (alive) setFbEnabled(!!cfg?.enabled); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const switchMode = (next) => {
    setMode(next);
    setError('');
    setNotice('');
  };

  const handleFacebook = async () => {
    setError('');
    setFbLoading(true);
    try {
      const cfg = await loadFacebookSdk();
      if (!cfg?.enabled) { setError('Facebook sign-in isn’t available.'); return; }
      const resp = await fbLogin({ scope: 'public_profile,email' });
      const token = resp?.authResponse?.accessToken;
      if (!token) { setError('Facebook sign-in was cancelled.'); return; }
      // Pass the partner slug: a first-time Facebook user is signed up here, and
      // their workspace must land under the partner whose link they arrived on.
      const { user } = await api.auth.facebook(token, partnerSlug ? { partnerSlug } : {});
      onLogin(user);
    } catch (err) {
      setError(err.message || 'Facebook sign-in failed.');
    } finally {
      setFbLoading(false);
    }
  };

  const accent = (brand?.primaryColor) || C.primary;
  const brandName = brand?.brandName || 'Zen Chat';
  // A partner (?w=slug) login must never show our identity: use their logo if
  // set, else render their brand name as text; only our own login uses /logo.png.
  const isWhiteLabel = !!brand?.isCustom;
  const logoSrc = brand?.logoUrl || (isWhiteLabel ? null : '/logo.png');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) { setError('Email and password required.'); return; }
    if (isSignup && password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (isSignup && !agreed) { setError('Please accept the Terms and Privacy Policy to continue.'); return; }
    setError('');
    setLoading(true);
    try {
      if (isSignup) {
        const res = await api.auth.signup({
          email, password, displayName: name, companyName: company, partnerSlug,
          acceptedTerms: agreed,
        });
        if (res.verificationRequired) {
          setMode('sent');
          // emailSent === false means the mailer REJECTED it — retrying will
          // fail identically. Telling them to press Resend would send them in a
          // loop; their account exists and only an operator can release it.
          setSendFailed(res.emailSent === false);
          setNotice('');
          return;
        }
        onLogin(res.user);
      } else {
        const { user } = await api.auth.login(email, password);
        onLogin(user);
      }
    } catch (err) {
      setError(err.message || (isSignup ? 'Could not create your account.' : 'Invalid credentials'));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setLoading(true);
    try {
      const r = await api.auth.resendVerification(email);
      setNotice(r.message || 'Link sent.');
    } catch {
      setNotice('Could not resend right now. Please try again shortly.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async () => {
    if (!email) { setError('Enter your email address first, then choose "Forgot password?".'); return; }
    setError('');
    setLoading(true);
    try {
      const r = await api.auth.forgotPassword(email);
      // The server answers { ok:false, code:'NO_MAILER' } when it can't send —
      // show that rather than a false "check your inbox" for mail that will
      // never arrive.
      setNotice(r.message || 'If an account exists for that address, we\'ve sent a reset link.');
    } catch (err) {
      setNotice(err.message || 'Could not start a password reset right now.');
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '11px 14px', borderRadius: 10,
    border: `1.5px solid ${C.border}`, fontSize: 14,
    fontFamily: FONT, outline: 'none', background: C.cardBg, color: C.text,
  };
  const focusOn = e => { e.target.style.borderColor = C.purple; e.target.style.boxShadow = '0 0 0 3px rgba(83,74,183,0.12)'; };
  const focusOff = e => { e.target.style.borderColor = C.border; e.target.style.boxShadow = 'none'; };
  const labelStyle = {
    fontSize: 11, fontWeight: 700, color: C.textSecondary,
    letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 6,
  };

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', fontFamily: FONT }}>
      {/* Left brand panel */}
      <div className="login-brand-panel" style={{
        flex: 1, minWidth: 0, background: C.headerBg,
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        padding: '48px 64px', position: 'relative', overflow: 'hidden',
        animation: 'fadeInLeft 0.55s cubic-bezier(0.16,1,0.3,1) both',
      }}>
        {/* Animated radial accents */}
        <div style={{
          position: 'absolute', top: '-20%', right: '-10%', width: '60%', height: '60%',
          background: 'radial-gradient(circle, rgba(220,38,38,0.18) 0%, transparent 70%)',
          pointerEvents: 'none',
          animation: 'fadeIn 1.2s ease-out 0.2s both',
        }} />
        <div style={{
          position: 'absolute', bottom: '-20%', left: '-10%', width: '50%', height: '50%',
          background: 'radial-gradient(circle, rgba(83,74,183,0.15) 0%, transparent 70%)',
          pointerEvents: 'none',
          animation: 'fadeIn 1.2s ease-out 0.4s both',
        }} />

        <div style={{ position: 'relative', zIndex: 1, maxWidth: 480 }} className="stagger">
          <div style={{ marginBottom: 40, animation: 'fadeInUp 0.5s ease-out 0.15s both' }}>
            {logoSrc
              ? <img src={logoSrc} alt={brandName}
                  style={{ height: 52, width: 'auto', objectFit: 'contain', display: 'block' }} />
              : <span style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.02em', color: C.headerText }}>{brandName}</span>}
          </div>
          <h1 style={{
            fontSize: 42, fontWeight: 700, color: C.headerText,
            letterSpacing: '-0.03em', lineHeight: 1.15, marginBottom: 20,
            animation: 'fadeInUp 0.5s ease-out 0.28s both',
          }}>
            {brand?.loginTagline || 'Manage conversations at scale'}
          </h1>
          <p style={{
            fontSize: 16, color: C.headerMuted, lineHeight: 1.65, marginBottom: 40,
            animation: 'fadeInUp 0.5s ease-out 0.38s both',
          }}>
            Reply to WhatsApp chats, build templates, send broadcasts, and automate
            responses — all from one place for your team.
          </p>

          {/* Feature pills */}
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 10,
            animation: 'fadeInUp 0.5s ease-out 0.48s both',
          }}>
            {['AI Agents', 'Broadcasts', 'Automations', 'Analytics'].map((f, i) => (
              <span key={f} style={{
                padding: '5px 13px', borderRadius: 20,
                border: `1px solid ${C.headerBorder}`,
                // Theme token, not hardcoded white: the brand panel is near-white
                // in light mode, where white text rendered the pills empty.
                fontSize: 12, fontWeight: 500, color: C.headerMuted,
                letterSpacing: '0.02em',
                animation: `fadeInUp 0.4s ease-out ${0.52 + i * 0.07}s both`,
              }}>{f}</span>
            ))}
          </div>
        </div>

        {!isWhiteLabel && (
          <div style={{ position: 'absolute', bottom: 28, left: 64, animation: 'fadeIn 0.6s ease-out 0.7s both' }}>
            <img src="/logo.png" alt="Zen Chat"
              style={{ height: 22, width: 'auto', objectFit: 'contain', opacity: 0.35 }} />
          </div>
        )}
      </div>

      {/* Right form panel */}
      <div className="login-form-panel" style={{
        width: '100%', maxWidth: 540, minWidth: 360, background: C.pageBg,
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        alignItems: 'center', padding: '40px 48px', overflowY: 'auto',
        animation: 'fadeIn 0.45s ease-out 0.1s both',
      }}>
        <div style={{ width: '100%', maxWidth: 400, animation: 'fadeInUp 0.5s ease-out 0.25s both' }}>
          {onBack && mode !== 'sent' && (
            <button
              type="button"
              onClick={onBack}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 22,
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                color: C.textSecondary, fontFamily: FONT, fontSize: 13, fontWeight: 600,
              }}
              onMouseEnter={e => { e.currentTarget.style.color = C.text; }}
              onMouseLeave={e => { e.currentTarget.style.color = C.textSecondary; }}
            >
              <ArrowLeft size={15} /> Back to home
            </button>
          )}

          {mode === 'sent' ? (
            <VerificationSent
              email={email}
              notice={notice}
              loading={loading}
              accent={accent}
              sendFailed={sendFailed}
              brandName={brandName}
              onResend={handleResend}
              onBackToSignIn={() => switchMode('signin')}
            />
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                {isSignup ? <UserPlus size={14} color={C.primary} /> : <Lock size={14} color={C.primary} />}
                <span style={{ fontSize: 11, fontWeight: 700, color: C.primary, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {isSignup ? 'Get started' : 'Sign In'}
                </span>
              </div>
              <h2 style={{ fontSize: 26, fontWeight: 700, color: C.text, marginBottom: 8, letterSpacing: '-0.02em' }}>
                {isSignup ? 'Create your workspace' : 'Welcome back'}
              </h2>
              <p style={{ fontSize: 14, color: C.textSecondary, marginBottom: 22, lineHeight: 1.5 }}>
                {isSignup
                  ? <>Start on the free plan — no card needed. Upgrade whenever you’re ready.</>
                  : <>Sign in to your {brandName} workspace</>}
              </p>

              {/* Real <button> tabs, not clickable divs: these must be reachable
                  by keyboard and announced as controls. */}
              <div role="tablist" aria-label="Sign in or create an account" style={{
                display: 'flex', gap: 4, padding: 4, marginBottom: 22,
                background: C.surfaceAlt, borderRadius: 10,
              }}>
                {[['signin', 'Sign in'], ['signup', 'Create account']].map(([key, label]) => {
                  const active = mode === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => switchMode(key)}
                      style={{
                        flex: 1, padding: '8px 10px', borderRadius: 7, border: 'none',
                        cursor: 'pointer', fontFamily: FONT, fontSize: 13, fontWeight: 600,
                        background: active ? C.cardBg : 'transparent',
                        color: active ? C.text : C.textSecondary,
                        boxShadow: active ? '0 1px 4px rgba(0,0,0,0.10)' : 'none',
                      }}
                    >{label}</button>
                  );
                })}
              </div>

              <form onSubmit={handleSubmit}>
                {isSignup && (
                  <>
                    <label style={{ display: 'block', marginBottom: 18 }}>
                      <div style={labelStyle}>Your name</div>
                      <input
                        type="text" placeholder="Priya Sharma" value={name}
                        onChange={e => setName(e.target.value)} autoFocus
                        style={inputStyle} onFocus={focusOn} onBlur={focusOff}
                      />
                    </label>
                    <label style={{ display: 'block', marginBottom: 18 }}>
                      <div style={labelStyle}>Company <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>(optional)</span></div>
                      <input
                        type="text" placeholder="Acme Pvt Ltd" value={company}
                        onChange={e => setCompany(e.target.value)}
                        style={inputStyle} onFocus={focusOn} onBlur={focusOff}
                      />
                    </label>
                  </>
                )}

                <label style={{ display: 'block', marginBottom: 18 }}>
                  <div style={labelStyle}>Email</div>
                  <input
                    type="email"
                    placeholder={isSignup ? 'you@company.com' : 'admin@example.com'}
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    autoFocus={!isSignup}
                    style={inputStyle} onFocus={focusOn} onBlur={focusOff}
                  />
                </label>

                <label style={{ display: 'block', marginBottom: isSignup ? 20 : 24 }}>
                  <div style={labelStyle}>Password</div>
                  <div style={{ position: 'relative' }}>
                    <input
                      type={showPw ? 'text' : 'password'}
                      placeholder="••••••••"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      style={{ ...inputStyle, padding: '11px 38px 11px 14px' }}
                      onFocus={focusOn} onBlur={focusOff}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw(v => !v)}
                      aria-label={showPw ? 'Hide password' : 'Show password'}
                      style={{
                        position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                        background: 'none', border: 'none', cursor: 'pointer', color: C.textSecondary,
                        display: 'flex', alignItems: 'center',
                      }}
                    >
                      {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  {isSignup ? (
                    <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 6 }}>
                      At least 8 characters.
                    </div>
                  ) : (
                    <div style={{ textAlign: 'right', marginTop: 8 }}>
                      <button
                        type="button"
                        onClick={handleForgot}
                        disabled={loading}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          color: C.textSecondary, fontFamily: FONT, fontSize: 12.5, fontWeight: 600,
                        }}
                      >
                        Forgot password?
                      </button>
                    </div>
                  )}
                </label>

                {/* Consent is captured, not assumed: the privacy policy asserts
                    the user agreed to it, so there must be an affirmative act.
                    The server re-checks this — the checkbox alone isn't evidence. */}
                {isSignup && (
                  <label style={{
                    display: 'flex', alignItems: 'flex-start', gap: 9, marginBottom: 18,
                    fontSize: 12.5, color: C.textSecondary, lineHeight: 1.5, cursor: 'pointer',
                  }}>
                    <input
                      type="checkbox"
                      checked={agreed}
                      onChange={e => setAgreed(e.target.checked)}
                      style={{ marginTop: 2, width: 15, height: 15, accentColor: accent, cursor: 'pointer', flexShrink: 0 }}
                    />
                    <span>
                      I agree to the{' '}
                      <a href="/terms-and-conditions" target="_blank" rel="noreferrer"
                        style={{ color: accent, fontWeight: 600 }}>Terms of Service</a>
                      {' '}and{' '}
                      <a href="/privacy-policy" target="_blank" rel="noreferrer"
                        style={{ color: accent, fontWeight: 600 }}>Privacy Policy</a>.
                    </span>
                  </label>
                )}

                {notice && !isSignup && (
                  <div style={{
                    background: C.surfaceAlt, color: C.textSecondary, borderRadius: 8,
                    padding: '10px 14px', fontSize: 12.5, marginBottom: 16, lineHeight: 1.5,
                  }}>{notice}</div>
                )}

                {error && (
                  <div role="alert" style={{
                    background: C.primaryLight, color: '#DC2626', borderRadius: 8,
                    padding: '10px 14px', fontSize: 13, marginBottom: 16, fontWeight: 500,
                    animation: 'popIn 0.22s cubic-bezier(0.34,1.56,0.64,1) both',
                  }}>
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width: '100%', padding: '13px', borderRadius: 10, border: 'none',
                    background: accent,
                    color: '#fff', fontSize: 14, fontWeight: 600,
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.75 : 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    fontFamily: FONT,
                    boxShadow: loading ? 'none' : '0 2px 12px rgba(0,0,0,0.18)',
                  }}
                  onMouseEnter={e => { if (!loading) { e.currentTarget.style.transform = 'translateY(-1px)'; } }}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'none'; }}
                >
                  {loading
                    ? <span style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                    : (isSignup ? <UserPlus size={16} /> : <LogIn size={16} />)}
                  {loading
                    ? (isSignup ? 'Creating…' : 'Signing in…')
                    : (isSignup ? 'Create account' : 'Sign in')}
                </button>
              </form>

              {fbEnabled && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '22px 0' }}>
                    <div style={{ flex: 1, height: 1, background: C.border }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: C.textSecondary, letterSpacing: '0.06em', textTransform: 'uppercase' }}>or</span>
                    <div style={{ flex: 1, height: 1, background: C.border }} />
                  </div>
                  <button
                    type="button"
                    onClick={handleFacebook}
                    disabled={fbLoading || loading}
                    style={{
                      width: '100%', padding: '12px', borderRadius: 10, border: 'none',
                      background: '#1877f2', color: '#fff', fontSize: 14, fontWeight: 600,
                      cursor: (fbLoading || loading) ? 'not-allowed' : 'pointer',
                      opacity: (fbLoading || loading) ? 0.75 : 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                      fontFamily: FONT,
                    }}
                    onMouseEnter={e => { if (!fbLoading && !loading) e.currentTarget.style.background = '#1668d6'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = '#1877f2'; }}
                  >
                    {fbLoading
                      ? <span style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                      : <FacebookGlyph />}
                    {fbLoading ? 'Connecting…' : (isSignup ? 'Continue with Facebook' : 'Sign in with Facebook')}
                  </button>
                  <p style={{ fontSize: 11.5, color: C.textMuted, marginTop: 10, textAlign: 'center', lineHeight: 1.5 }}>
                    {isSignup ? (
                      // The Facebook button creates an account, so consent must be
                      // disclosed here too — there's no checkbox in that path.
                      <>
                        We’ll create your workspace from your Facebook account. By continuing you agree
                        to our{' '}
                        <a href="/terms-and-conditions" target="_blank" rel="noreferrer" style={{ color: accent, fontWeight: 600 }}>Terms</a>
                        {' '}and{' '}
                        <a href="/privacy-policy" target="_blank" rel="noreferrer" style={{ color: accent, fontWeight: 600 }}>Privacy Policy</a>.
                      </>
                    ) : 'New here? Facebook works for signing up too.'}
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .login-brand-panel { display: none !important; }
          .login-form-panel  { max-width: 100% !important; padding: 24px !important; }
        }
      `}</style>
    </div>
  );
}

// Shown after signup on an install that CAN send mail. The account exists but is
// not usable until the link is clicked, so this screen is the whole story — no
// way forward from here except the inbox.
function VerificationSent({ email, notice, loading, accent, sendFailed, brandName, onResend, onBackToSignIn }) {
  // The mailer REJECTED the send. The account exists but is unreachable, and
  // pressing Resend repeats the identical failure — so don't offer it, and don't
  // tell them to watch an inbox nothing is coming to. Say what actually happened
  // and whose problem it is.
  if (sendFailed) {
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%', background: 'rgba(245,158,11,.14)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 20px', animation: 'popIn 0.3s cubic-bezier(0.34,1.56,0.64,1) both',
        }}>
          <AlertTriangle size={26} color="#B45309" />
        </div>
        <h2 style={{ fontSize: 24, fontWeight: 700, color: C.text, marginBottom: 10, letterSpacing: '-0.02em' }}>
          Your account is ready — our email isn’t
        </h2>
        <p style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.6, marginBottom: 6 }}>
          We created your workspace for
        </p>
        <p style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 18, wordBreak: 'break-all' }}>
          {email}
        </p>
        <div style={{
          background: 'rgba(245,158,11,.12)', color: '#B45309', border: '1px solid rgba(245,158,11,.3)',
          borderRadius: 10, padding: '11px 13px', fontSize: 13, lineHeight: 1.6,
          marginBottom: 20, textAlign: 'left',
        }}>
          But we couldn’t send your confirmation link — that’s a problem on our side, not yours.
          The {brandName} team can see this and will activate your account. You don’t need to
          sign up again, and trying again won’t help.
        </div>
        <button
          type="button"
          onClick={onBackToSignIn}
          style={{
            width: '100%', padding: '12px', borderRadius: 10,
            border: `1.5px solid ${C.border}`, background: C.cardBg, color: C.text,
            fontSize: 14, fontWeight: 600, fontFamily: FONT, cursor: 'pointer',
          }}
        >
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        width: 56, height: 56, borderRadius: '50%', background: C.primaryLight,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 20px', animation: 'popIn 0.3s cubic-bezier(0.34,1.56,0.64,1) both',
      }}>
        <MailCheck size={26} color={accent} />
      </div>
      <h2 style={{ fontSize: 24, fontWeight: 700, color: C.text, marginBottom: 10, letterSpacing: '-0.02em' }}>
        Check your inbox
      </h2>
      <p style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.6, marginBottom: 6 }}>
        We sent a confirmation link to
      </p>
      <p style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 18, wordBreak: 'break-all' }}>
        {email}
      </p>
      <p style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6, marginBottom: 22 }}>
        Click it to activate your workspace. The link expires in 24 hours.
      </p>

      {notice && (
        <div style={{
          background: C.surfaceAlt, color: C.textSecondary, borderRadius: 8,
          padding: '10px 14px', fontSize: 12.5, marginBottom: 16, lineHeight: 1.5,
        }}>{notice}</div>
      )}

      <button
        type="button"
        onClick={onResend}
        disabled={loading}
        style={{
          width: '100%', padding: '12px', borderRadius: 10,
          border: `1.5px solid ${C.border}`, background: C.cardBg, color: C.text,
          fontSize: 14, fontWeight: 600, fontFamily: FONT,
          cursor: loading ? 'not-allowed' : 'pointer', marginBottom: 12,
        }}
      >
        {loading ? 'Sending…' : 'Resend the link'}
      </button>
      <button
        type="button"
        onClick={onBackToSignIn}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 4,
          color: C.textSecondary, fontFamily: FONT, fontSize: 13, fontWeight: 600,
        }}
      >
        Back to sign in
      </button>
    </div>
  );
}

// Facebook "f" wordmark glyph (white), inline SVG so it needs no external asset.
function FacebookGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}
