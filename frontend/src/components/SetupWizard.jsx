import { useState } from 'react';
import { ShieldCheck, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

// First-run setup: shown when the instance has no users yet. Creates the admin
// account in the browser (POST /auth/setup), so deployment needs no admin
// credentials in the environment. Mirrors LoginGate's two-panel layout.
export default function SetupWizard({ onComplete }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) { setError('Email and password are required.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setError('');
    setLoading(true);
    try {
      const { user } = await api.auth.setup(email, password, name);
      onComplete(user);
    } catch (err) {
      setError(err.message || 'Could not complete setup.');
    } finally {
      setLoading(false);
    }
  };

  const labelStyle = {
    fontSize: 11, fontWeight: 700, color: C.textSecondary,
    letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 6,
  };
  const inputStyle = {
    width: '100%', padding: '11px 14px', borderRadius: 10,
    border: `1.5px solid ${C.border}`, fontSize: 14, fontFamily: FONT,
    outline: 'none', background: C.cardBg, color: C.text, transition: 'border .15s',
  };
  const onFocus = (e) => { e.target.style.borderColor = C.purple; e.target.style.boxShadow = ' 0 0 0 3px rgba(83,74,183,0.12)'; };
  const onBlur  = (e) => { e.target.style.borderColor = C.border;  e.target.style.boxShadow = 'none'; };

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', fontFamily: FONT }}>
      {/* Left brand panel */}
      <div className="login-brand-panel" style={{
        flex: 1, minWidth: 0, background: C.headerBg, display: 'flex',
        flexDirection: 'column', justifyContent: 'center', padding: '48px 64px',
        position: 'relative', overflow: 'hidden',
        animation: 'fadeInLeft 0.55s cubic-bezier(0.16,1,0.3,1) both',
      }}>
        <div style={{ position: 'absolute', top: '-20%', right: '-10%', width: '60%', height: '60%',
          background: 'radial-gradient(circle, rgba(220,38,38,0.18) 0%, transparent 70%)', pointerEvents: 'none',
          animation: 'fadeIn 1.2s ease-out 0.2s both' }} />
        <div style={{ position: 'absolute', bottom: '-20%', left: '-10%', width: '50%', height: '50%',
          background: 'radial-gradient(circle, rgba(83,74,183,0.15) 0%, transparent 70%)', pointerEvents: 'none',
          animation: 'fadeIn 1.2s ease-out 0.4s both' }} />
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 480 }}>
          <div style={{ marginBottom: 40, animation: 'fadeInUp 0.5s ease-out 0.15s both' }}>
            <img src="/logo.png" alt="Zen Chat"
              style={{ height: 44, width: 'auto', objectFit: 'contain', display: 'block' }} />
          </div>
          <h1 style={{ fontSize: 42, fontWeight: 700, color: C.headerText, letterSpacing: '-0.03em', lineHeight: 1.15, marginBottom: 20, animation: 'fadeInUp 0.5s ease-out 0.28s both' }}>
            Let's get you set up
          </h1>
          <p style={{ fontSize: 16, color: C.headerMuted, lineHeight: 1.65, marginBottom: 40, animation: 'fadeInUp 0.5s ease-out 0.38s both' }}>
            Create your admin account to finish installing. After this you'll connect your WhatsApp account and start managing conversations — all from here.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, animation: 'fadeInUp 0.5s ease-out 0.48s both' }}>
            {['One-time setup', 'No credit card', 'Self-hosted'].map((f) => (
              <span key={f} style={{
                padding: '5px 13px', borderRadius: 20,
                border: '1px solid rgba(0,0,0,0.14)',
                fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.65)',
              }}>{f}</span>
            ))}
          </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <ShieldCheck size={14} color={C.primary} />
            <span style={{ fontSize: 11, fontWeight: 700, color: C.primary, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              First-time setup
            </span>
          </div>
          <h2 style={{ fontSize: 26, fontWeight: 700, color: C.text, marginBottom: 8, letterSpacing: '-0.02em' }}>
            Create your admin account
          </h2>
          <p style={{ fontSize: 14, color: C.textSecondary, marginBottom: 28, lineHeight: 1.5 }}>
            You're the first user — this becomes the owner account.
          </p>

          <form onSubmit={handleSubmit}>
            <label style={{ display: 'block', marginBottom: 18 }}>
              <div style={labelStyle}>Your name <span style={{ textTransform: 'none', color: C.textMuted, fontWeight: 500 }}>(optional)</span></div>
              <input type="text" placeholder="Jane Doe" value={name}
                onChange={e => setName(e.target.value)}
                style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
            </label>

            <label style={{ display: 'block', marginBottom: 18 }}>
              <div style={labelStyle}>Email</div>
              <input type="email" placeholder="you@company.com" value={email} autoFocus
                onChange={e => setEmail(e.target.value)}
                style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
            </label>

            <label style={{ display: 'block', marginBottom: 18 }}>
              <div style={labelStyle}>Password</div>
              <div style={{ position: 'relative' }}>
                <input type={showPw ? 'text' : 'password'} placeholder="At least 8 characters" value={password}
                  onChange={e => setPassword(e.target.value)}
                  style={{ ...inputStyle, paddingRight: 44 }} onFocus={onFocus} onBlur={onBlur} />
                <button type="button" onClick={() => setShowPw(v => !v)} aria-label={showPw ? 'Hide password' : 'Show password'}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, display: 'flex', padding: 4 }}>
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>

            <label style={{ display: 'block', marginBottom: 24 }}>
              <div style={labelStyle}>Confirm password</div>
              <input type={showPw ? 'text' : 'password'} placeholder="Re-enter password" value={confirm}
                onChange={e => setConfirm(e.target.value)}
                style={inputStyle} onFocus={onFocus} onBlur={onBlur} />
            </label>

            {error && (
              <div style={{ background: 'rgba(239,68,68,.14)', color: '#DC2626', borderRadius: 8, padding: '10px 12px', fontSize: 13, fontWeight: 500, marginBottom: 18, animation: 'popIn 0.22s cubic-bezier(0.34,1.56,0.64,1) both' }}>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading}
              style={{ width: '100%', padding: '13px 16px', borderRadius: 10, border: 'none',
                background: C.primary, color: '#fff', fontSize: 14, fontWeight: 700, fontFamily: FONT,
                cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.75 : 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                boxShadow: '0 2px 12px rgba(220,38,38,0.28)' }}
              onMouseEnter={e => { if (!loading) { e.currentTarget.style.background = C.primaryHover; e.currentTarget.style.boxShadow = '0 4px 20px rgba(220,38,38,0.38)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
              onMouseLeave={e => { e.currentTarget.style.background = C.primary; e.currentTarget.style.boxShadow = '0 2px 12px rgba(220,38,38,0.28)'; e.currentTarget.style.transform = 'none'; }}
            >
              {loading
                ? <span style={{ display: 'inline-block', width: 16, height: 16, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                : null}
              {loading ? 'Creating…' : 'Create account & continue'}
              {!loading && <ArrowRight size={16} />}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
