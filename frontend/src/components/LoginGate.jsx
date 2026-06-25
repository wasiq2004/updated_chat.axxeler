import { useState } from 'react';
import { Lock, LogIn, Eye, EyeOff, ArrowLeft } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

export default function LoginGate({ onLogin, onBack }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) { setError('Email and password required.'); return; }
    setError('');
    setLoading(true);
    try {
      const { user } = await api.auth.login(email, password);
      onLogin(user);
    } catch (err) {
      setError(err.message || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
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
            <img src="/logo.png" alt="Zen Chat"
              style={{ height: 52, width: 'auto', objectFit: 'contain', display: 'block' }} />
          </div>
          <h1 style={{
            fontSize: 42, fontWeight: 700, color: C.headerText,
            letterSpacing: '-0.03em', lineHeight: 1.15, marginBottom: 20,
            animation: 'fadeInUp 0.5s ease-out 0.28s both',
          }}>
            Manage conversations at scale
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
                border: '1px solid rgba(0,0,0,0.14)',
                fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.65)',
                letterSpacing: '0.02em',
                animation: `fadeInUp 0.4s ease-out ${0.52 + i * 0.07}s both`,
              }}>{f}</span>
            ))}
          </div>
        </div>

        <div style={{ position: 'absolute', bottom: 28, left: 64, animation: 'fadeIn 0.6s ease-out 0.7s both' }}>
          <img src="/logo.png" alt="Zen Chat"
            style={{ height: 22, width: 'auto', objectFit: 'contain', opacity: 0.35 }} />
        </div>
      </div>

      {/* Right form panel */}
      <div className="login-form-panel" style={{
        width: '100%', maxWidth: 540, minWidth: 360, background: C.pageBg,
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        alignItems: 'center', padding: '40px 48px', overflowY: 'auto',
        animation: 'fadeIn 0.45s ease-out 0.1s both',
      }}>
        <div style={{ width: '100%', maxWidth: 400, animation: 'fadeInUp 0.5s ease-out 0.25s both' }}>
          {onBack && (
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Lock size={14} color={C.primary} />
            <span style={{ fontSize: 11, fontWeight: 700, color: C.primary, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Sign In
            </span>
          </div>
          <h2 style={{ fontSize: 26, fontWeight: 700, color: C.text, marginBottom: 8, letterSpacing: '-0.02em' }}>
            Welcome back
          </h2>
          <p style={{ fontSize: 14, color: C.textSecondary, marginBottom: 28, lineHeight: 1.5 }}>
            Sign in to your Zen Chat workspace
          </p>

          <form onSubmit={handleSubmit}>
            <label style={{ display: 'block', marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary, letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 6 }}>
                Email
              </div>
              <input
                type="email"
                placeholder="admin@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoFocus
                style={{
                  width: '100%', padding: '11px 14px', borderRadius: 10,
                  border: `1.5px solid ${C.border}`, fontSize: 14,
                  fontFamily: FONT, outline: 'none', background: C.cardBg, color: C.text,
                }}
                onFocus={e => { e.target.style.borderColor = C.purple; e.target.style.boxShadow = `0 0 0 3px rgba(83,74,183,0.12)`; }}
                onBlur={e => { e.target.style.borderColor = C.border; e.target.style.boxShadow = 'none'; }}
              />
            </label>

            <label style={{ display: 'block', marginBottom: 24 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary, letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 6 }}>
                Password
              </div>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPw ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  style={{
                    width: '100%', padding: '11px 38px 11px 14px', borderRadius: 10,
                    border: `1.5px solid ${C.border}`, fontSize: 14,
                    fontFamily: FONT, outline: 'none', background: C.cardBg, color: C.text,
                  }}
                  onFocus={e => { e.target.style.borderColor = C.purple; e.target.style.boxShadow = `0 0 0 3px rgba(83,74,183,0.12)`; }}
                  onBlur={e => { e.target.style.borderColor = C.border; e.target.style.boxShadow = 'none'; }}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: C.textSecondary,
                    display: 'flex', alignItems: 'center',
                  }}
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>

            {error && (
              <div style={{
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
                background: loading ? C.primaryHover : C.primary,
                color: '#fff', fontSize: 14, fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.75 : 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                fontFamily: FONT,
                boxShadow: loading ? 'none' : '0 2px 12px rgba(220,38,38,0.28)',
              }}
              onMouseEnter={e => { if (!loading) { e.currentTarget.style.background = C.primaryHover; e.currentTarget.style.boxShadow = '0 4px 20px rgba(220,38,38,0.38)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
              onMouseLeave={e => { e.currentTarget.style.background = loading ? C.primaryHover : C.primary; e.currentTarget.style.boxShadow = loading ? 'none' : '0 2px 12px rgba(220,38,38,0.28)'; e.currentTarget.style.transform = 'none'; }}
            >
              {loading
                ? <span style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                : <LogIn size={16} />}
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
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
