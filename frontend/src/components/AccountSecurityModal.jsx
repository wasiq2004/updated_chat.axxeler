import { useState, useEffect } from 'react';
import { X, KeyRound, ShieldCheck, Check, AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';
import { loadFacebookSdk, fbLogin } from '../lib/facebook.js';

/**
 * Account & security — the signed-in user managing their OWN credentials.
 *
 * This is a modal rather than a page on purpose: a password screen must be
 * reachable by every role, and page ids are permission-gated (a 'viewer' only
 * has ['home','about'], so any new page would be force-redirected away from
 * them). A modal from the Topbar menu has no such gate.
 *
 * Two jobs, both previously impossible:
 *   1. Set a password. A Facebook signup's stored hash is random bytes nobody
 *      knows — without this they were one lost Facebook account away from being
 *      locked out of their own workspace forever.
 *   2. Connect Facebook. "Sign in with Facebook" only works once fb_user_id is
 *      set, and nothing ever set it for a password signup.
 *
 * Props:
 *   user      — the session user (passwordSet, facebookLinked, signupSource)
 *   onClose()
 *   onChanged() — credentials changed; parent should refresh the session
 */
export default function AccountSecurityModal({ user, onClose, onChanged }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwDone, setPwDone] = useState(false);

  const [fbEnabled, setFbEnabled] = useState(false);
  const [fbBusy, setFbBusy] = useState(false);
  const [fbError, setFbError] = useState('');

  // `passwordSet === false` means the account literally has no password its
  // owner could know — so asking for the current one would be impossible.
  const hasPassword = user?.passwordSet !== false;
  const linked = !!user?.facebookLinked;

  useEffect(() => {
    let alive = true;
    loadFacebookSdk().then(cfg => { if (alive) setFbEnabled(!!cfg?.enabled); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const savePassword = async (e) => {
    e.preventDefault();
    if (next.length < 8) { setPwError('Password must be at least 8 characters.'); return; }
    if (next !== confirm) { setPwError('Those passwords don’t match.'); return; }
    if (hasPassword && !current) { setPwError('Enter your current password.'); return; }
    setPwError('');
    setPwBusy(true);
    try {
      await api.auth.setPassword(next, hasPassword ? current : undefined);
      setPwDone(true);
      setCurrent(''); setNext(''); setConfirm('');
      onChanged?.();
    } catch (err) {
      setPwError(err.message || 'Could not update your password.');
    } finally {
      setPwBusy(false);
    }
  };

  const connectFacebook = async () => {
    setFbError('');
    setFbBusy(true);
    try {
      const cfg = await loadFacebookSdk();
      if (!cfg?.enabled) { setFbError('Facebook isn’t enabled on this server.'); return; }
      // Identity scope + the default token flow — NOT the Embedded Signup
      // config_id/response_type:'code' shape, which returns a code and no user
      // token, and is why linking never worked.
      const resp = await fbLogin({ scope: 'public_profile,email' });
      const token = resp?.authResponse?.accessToken;
      if (!token) { setFbError('Facebook connection was cancelled.'); return; }
      await api.auth.linkFacebook(token);
      onChanged?.();
    } catch (err) {
      setFbError(err.message || 'Could not connect Facebook.');
    } finally {
      setFbBusy(false);
    }
  };

  const disconnectFacebook = async () => {
    setFbError('');
    setFbBusy(true);
    try {
      await api.auth.unlinkFacebook();
      onChanged?.();
    } catch (err) {
      setFbError(err.message || 'Could not disconnect Facebook.');
    } finally {
      setFbBusy(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '10px 38px 10px 12px', borderRadius: 9,
    border: `1.5px solid ${C.border}`, fontSize: 13.5,
    fontFamily: FONT, outline: 'none', background: C.cardBg, color: C.text,
  };
  const labelStyle = {
    fontSize: 10.5, fontWeight: 700, color: C.textSecondary,
    letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 5,
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 300, fontFamily: FONT,
        background: 'rgba(15,15,25,0.5)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        animation: 'fadeIn 0.18s ease-out both',
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Account and security"
        style={{
          width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto',
          background: C.cardBg, borderRadius: 16, boxShadow: C.shadowLg,
          border: `1px solid ${C.border}`,
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 22px 14px', borderBottom: `1px solid ${C.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ShieldCheck size={18} color={C.primary} />
            <span style={{ fontSize: 15.5, fontWeight: 800, color: C.text, letterSpacing: '-0.01em' }}>
              Account &amp; security
            </span>
          </div>
          <button
            type="button" onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textSecondary, display: 'flex' }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '20px 22px 24px' }}>
          {/* ── Password ─────────────────────────────────────────────────── */}
          {!hasPassword && (
            <div style={{
              display: 'flex', gap: 9, alignItems: 'flex-start',
              padding: '11px 13px', borderRadius: 9, marginBottom: 16,
              background: 'rgba(245,158,11,.12)', color: '#B45309',
              border: '1px solid rgba(245,158,11,.3)', fontSize: 12.5, lineHeight: 1.55,
            }}>
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                You sign in with Facebook and have no password yet. Set one so you don’t
                lose access to your workspace if you ever lose your Facebook account.
              </span>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <KeyRound size={15} color={C.textSecondary} />
            <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>
              {hasPassword ? 'Change your password' : 'Set a password'}
            </span>
          </div>

          <form onSubmit={savePassword} style={{ marginBottom: 26 }}>
            {hasPassword && (
              <label style={{ display: 'block', marginBottom: 12 }}>
                <div style={labelStyle}>Current password</div>
                <input
                  type="password" value={current} onChange={e => setCurrent(e.target.value)}
                  placeholder="••••••••" style={inputStyle} autoComplete="current-password"
                />
              </label>
            )}
            <label style={{ display: 'block', marginBottom: 12 }}>
              <div style={labelStyle}>New password</div>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPw ? 'text' : 'password'} value={next}
                  onChange={e => setNext(e.target.value)} placeholder="••••••••"
                  style={inputStyle} autoComplete="new-password"
                />
                <button
                  type="button" onClick={() => setShowPw(v => !v)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  style={{
                    position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: C.textSecondary,
                    display: 'flex', alignItems: 'center',
                  }}
                >
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 5 }}>At least 8 characters.</div>
            </label>
            <label style={{ display: 'block', marginBottom: 14 }}>
              <div style={labelStyle}>Confirm new password</div>
              <input
                type={showPw ? 'text' : 'password'} value={confirm}
                onChange={e => setConfirm(e.target.value)} placeholder="••••••••"
                style={inputStyle} autoComplete="new-password"
              />
            </label>

            {pwError && (
              <div role="alert" style={{
                background: C.primaryLight, color: '#DC2626', borderRadius: 8,
                padding: '9px 12px', fontSize: 12.5, marginBottom: 12, fontWeight: 500,
              }}>{pwError}</div>
            )}
            {pwDone && !pwError && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 7,
                background: 'rgba(37,211,102,.12)', color: '#0b7a3b', borderRadius: 8,
                padding: '9px 12px', fontSize: 12.5, marginBottom: 12, fontWeight: 600,
              }}>
                <Check size={14} /> Password updated.
              </div>
            )}

            <button
              type="submit" disabled={pwBusy}
              style={{
                width: '100%', padding: '11px', borderRadius: 9, border: 'none',
                background: C.primary, color: '#fff', fontSize: 13.5, fontWeight: 700,
                cursor: pwBusy ? 'not-allowed' : 'pointer', opacity: pwBusy ? 0.7 : 1,
                fontFamily: FONT,
              }}
            >
              {pwBusy ? 'Saving…' : (hasPassword ? 'Update password' : 'Set password')}
            </button>
          </form>

          {/* ── Facebook ─────────────────────────────────────────────────── */}
          {fbEnabled && (
            <>
              <div style={{ height: 1, background: C.border, marginBottom: 18 }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <FacebookGlyph color="#1877f2" />
                <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>Facebook sign-in</span>
              </div>
              <p style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.55, margin: '0 0 12px' }}>
                {linked
                  ? 'Your Facebook account is connected — you can use “Sign in with Facebook” on the login page.'
                  : 'Connect your Facebook account to sign in with one tap next time.'}
              </p>

              {fbError && (
                <div role="alert" style={{
                  background: C.primaryLight, color: '#DC2626', borderRadius: 8,
                  padding: '9px 12px', fontSize: 12.5, marginBottom: 12, fontWeight: 500,
                }}>{fbError}</div>
              )}

              {linked ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: 'rgba(37,211,102,.12)', color: '#0b7a3b',
                    padding: '6px 11px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                  }}>
                    <Check size={13} /> Connected
                  </span>
                  <button
                    type="button" onClick={disconnectFacebook} disabled={fbBusy}
                    style={{
                      background: 'none', border: 'none', padding: 4, cursor: fbBusy ? 'not-allowed' : 'pointer',
                      color: C.textSecondary, fontFamily: FONT, fontSize: 12.5, fontWeight: 600,
                    }}
                  >
                    {fbBusy ? 'Working…' : 'Disconnect'}
                  </button>
                </div>
              ) : (
                <button
                  type="button" onClick={connectFacebook} disabled={fbBusy}
                  style={{
                    width: '100%', padding: '11px', borderRadius: 9, border: 'none',
                    background: '#1877f2', color: '#fff', fontSize: 13.5, fontWeight: 700,
                    cursor: fbBusy ? 'not-allowed' : 'pointer', opacity: fbBusy ? 0.7 : 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                    fontFamily: FONT,
                  }}
                >
                  <FacebookGlyph color="#fff" />
                  {fbBusy ? 'Connecting…' : 'Connect Facebook'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FacebookGlyph({ color }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill={color} aria-hidden="true">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}
