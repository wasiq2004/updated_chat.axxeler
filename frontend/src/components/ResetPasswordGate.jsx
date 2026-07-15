import { useState } from 'react';
import { KeyRound, Eye, EyeOff } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

/**
 * Landing screen for the ?reset=<token> link from the forgot-password email.
 * Choosing a new password signs them straight in — the token already proved they
 * control the address, so a second login step would be friction for nothing.
 *
 * Props:
 *   token      — the raw reset token from the URL
 *   onDone(u)  — a new password was set; `u` is the session user
 *   onExpired() — the token was invalid/expired/spent; go to sign in
 */
export default function ResetPasswordGate({ token, onDone, onExpired }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    // Checked here rather than server-side: a typo'd new password would lock
    // them out again, and the token is single-use so they couldn't retry.
    if (password !== confirm) { setError('Those passwords don’t match.'); return; }
    setError('');
    setBusy(true);
    try {
      const { user } = await api.auth.resetPassword(token, password);
      onDone(user);
    } catch (err) {
      if (/expired|invalid/i.test(err.message || '')) { onExpired(); return; }
      setError(err.message || 'Could not reset your password.');
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '11px 38px 11px 14px', borderRadius: 10,
    border: `1.5px solid ${C.border}`, fontSize: 14,
    fontFamily: FONT, outline: 'none', background: C.cardBg, color: C.text,
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: FONT, background: C.pageBg, padding: 24,
    }}>
      <form onSubmit={submit} style={{
        width: '100%', maxWidth: 400, background: C.cardBg,
        border: `1px solid ${C.border}`, borderRadius: 16, padding: '30px 28px',
        boxShadow: C.shadowSm,
      }}>
        <div style={{
          width: 46, height: 46, borderRadius: 12, background: C.primaryLight,
          display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16,
        }}>
          <KeyRound size={22} color={C.primary} />
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: C.text, margin: '0 0 6px', letterSpacing: '-0.02em' }}>
          Choose a new password
        </h1>
        <p style={{ fontSize: 13.5, color: C.textSecondary, margin: '0 0 22px', lineHeight: 1.55 }}>
          You’ll be signed in straight away once it’s set.
        </p>

        <label style={{ display: 'block', marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary, letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 6 }}>
            New password
          </div>
          <div style={{ position: 'relative' }}>
            <input
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoFocus
              style={inputStyle}
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
          <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 6 }}>At least 8 characters.</div>
        </label>

        <label style={{ display: 'block', marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textSecondary, letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 6 }}>
            Confirm password
          </div>
          <input
            type={showPw ? 'text' : 'password'}
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            placeholder="••••••••"
            style={inputStyle}
          />
        </label>

        {error && (
          <div role="alert" style={{
            background: C.primaryLight, color: '#DC2626', borderRadius: 8,
            padding: '10px 14px', fontSize: 13, marginBottom: 16, fontWeight: 500,
          }}>{error}</div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            width: '100%', padding: '13px', borderRadius: 10, border: 'none',
            background: C.primary, color: '#fff', fontSize: 14, fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.75 : 1,
            fontFamily: FONT,
          }}
        >
          {busy ? 'Saving…' : 'Set password & sign in'}
        </button>
      </form>
    </div>
  );
}
