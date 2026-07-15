import { useState, useRef, useEffect, useCallback } from 'react';
import { X, ShieldCheck, Zap, PlugZap, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';
import { loadFacebookSdk, fbLogin } from '../lib/facebook.js';

/**
 * Post-login popup that invites a tenant admin to connect their WhatsApp Business
 * account via Facebook (Meta Embedded Signup). On success it stores the WABA +
 * links the person's Facebook identity so they can later "Sign in with Facebook".
 *
 * Props:
 *   onClose()      — dismiss / done. Also what the success screen's Continue does.
 *   onConnected()  — a number WAS connected. Fires as soon as the save succeeds,
 *                    before the success screen is shown, so a parent list can
 *                    refresh behind it. It must NOT close the modal: doing so
 *                    skips the success screen — including the two-step-PIN
 *                    warning, which is the one thing the user needs to read.
 *   context        — 'firstRun' (the post-login nudge) or 'settings' (opened
 *                    from Settings → WhatsApp Accounts). Only changes copy: the
 *                    nudge's "I'll do this later" and "you can connect manually
 *                    in Settings" are nonsense once you're already in Settings.
 */
export default function ConnectWhatsAppModal({ onClose, onConnected, context = 'firstRun' }) {
  const isFirstRun = context !== 'settings';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [warning, setWarning] = useState('');
  const sessionRef = useRef(null); // { wabaId, phoneNumberId } from the FB message event
  const errorRef = useRef(null);   // error_message from a CANCEL/ERROR event

  // Meta posts the WhatsApp Business + Phone IDs to the opener via postMessage
  // during Embedded Signup. Capture them for the code-exchange call.
  useEffect(() => {
    const onMessage = (event) => {
      let host = '';
      try { host = new URL(event.origin).hostname; } catch { return; }
      if (host !== 'www.facebook.com' && !host.endsWith('.facebook.com')) return;
      if (typeof event.data !== 'string') return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type !== 'WA_EMBEDDED_SIGNUP' || !data.data) return;
      // Meta sends event: 'FINISH' | 'CANCEL' | 'ERROR'. Only FINISH means the
      // person completed every step. A CANCEL/ERROR can still carry partial data
      // (e.g. a waba_id chosen before they bailed) — treating that as success
      // would post a half-finished signup to the backend.
      if (data.event && data.event !== 'FINISH') {
        sessionRef.current = null;
        errorRef.current = data.data.error_message || null;
        return;
      }
      sessionRef.current = {
        wabaId: data.data.waba_id || null,
        phoneNumberId: data.data.phone_number_id || null,
      };
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const launch = useCallback(async () => {
    setError('');
    setBusy(true);
    try {
      const cfg = await loadFacebookSdk();
      if (!cfg?.enabled) { setError('Facebook connect isn’t available on this server.'); return; }
      if (!cfg.configId) { setError('Embedded Signup isn’t configured (missing config id). Contact your administrator.'); return; }

      sessionRef.current = null;
      errorRef.current = null;
      setWarning('');
      const resp = await fbLogin({
        config_id: cfg.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { version: 'v4' },
      });

      const code = resp?.authResponse?.code;
      if (!code) { setError('Facebook connection was cancelled.'); return; }

      const session = sessionRef.current || {};
      if (!session.wabaId || !session.phoneNumberId) {
        // Prefer Meta's own reason when the flow reported one — "please try
        // again" is useless when the real cause was e.g. an unverified business.
        setError(errorRef.current
          || 'Couldn’t read your WhatsApp Business details from Facebook. Please try again and finish every step.');
        return;
      }

      const result = await api.whatsappAccounts.embeddedSignup({
        code,
        wabaId: session.wabaId,
        phoneNumberId: session.phoneNumberId,
        fbUserId: resp?.authResponse?.userID || null,
      });

      // The number is saved either way, but if Meta refused to register it, it
      // cannot send yet. Say so here rather than letting them discover it when
      // their first broadcast fails.
      if (result && result.registered === false) {
        setWarning(
          result.registrationCode === 133005
            ? 'Connected — but this number already has a two-step PIN we don’t know, so we couldn’t finish registering it. Reset the PIN in Meta Business Manager, then reconnect.'
            : `Connected — but Meta couldn’t finish registering it to send messages: ${result.registrationError}`
        );
      }

      setDone(true);
      onConnected?.();
    } catch (err) {
      setError(err.message || 'Could not connect WhatsApp via Facebook.');
    } finally {
      setBusy(false);
    }
  }, [onConnected]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 500, fontFamily: FONT,
        background: 'rgba(15,15,25,0.55)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        animation: 'fadeIn 0.2s ease-out both',
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}
    >
      <div style={{
        width: '100%', maxWidth: 460, background: C.cardBg, borderRadius: 18,
        overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,0.35)',
        animation: 'popIn 0.26s cubic-bezier(0.34,1.56,0.64,1) both',
      }}>
        {/* Gradient header */}
        <div style={{
          position: 'relative',
          background: 'linear-gradient(135deg, #1877f2 0%, #22a5f2 55%, #25D366 100%)',
          padding: '30px 28px 26px', color: '#fff', overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', top: -40, right: -30, width: 160, height: 160,
            borderRadius: '50%', background: 'rgba(255,255,255,0.12)', pointerEvents: 'none',
          }} />
          {!busy && (
            <button onClick={onClose} aria-label="Close" style={{
              position: 'absolute', top: 14, right: 14, background: 'rgba(255,255,255,0.18)',
              border: 'none', borderRadius: 8, width: 30, height: 30, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
            }}><X size={16} /></button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, position: 'relative' }}>
            <GlyphBubble><FacebookGlyph /></GlyphBubble>
            <span style={{ fontSize: 20, fontWeight: 300, opacity: 0.85 }}>→</span>
            <GlyphBubble><WhatsAppGlyph /></GlyphBubble>
          </div>
          <h2 style={{ fontSize: 21, fontWeight: 700, margin: 0, letterSpacing: '-0.02em', position: 'relative' }}>
            Connect WhatsApp via Facebook
          </h2>
          <p style={{ fontSize: 13.5, margin: '7px 0 0', opacity: 0.92, lineHeight: 1.5, position: 'relative' }}>
            Link your WhatsApp Business account in a few clicks — no access tokens to copy or paste.
          </p>
        </div>

        {/* Body */}
        <div style={{ padding: '22px 28px 26px' }}>
          {done ? (
            <div style={{ textAlign: 'center', padding: '10px 0 6px' }}>
              {/* A half-connected number is not a success. When Meta refused to
                  register it, drop the celebration and lead with what's wrong —
                  the number cannot send until it's resolved. */}
              {warning ? (
                <AlertTriangle size={44} color={C.amber} style={{ marginBottom: 12 }} />
              ) : (
                <CheckCircle2 size={44} color="#25D366" style={{ marginBottom: 12 }} />
              )}
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>
                {warning ? 'Almost there' : 'WhatsApp connected!'}
              </div>
              {warning ? (
                <p style={{
                  fontSize: 13, lineHeight: 1.55, margin: '0 0 18px', textAlign: 'left',
                  background: 'rgba(245,158,11,.12)', color: '#B45309',
                  border: '1px solid rgba(245,158,11,.3)', borderRadius: 10, padding: '11px 13px',
                }}>{warning}</p>
              ) : (
                <p style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.55, margin: '0 0 18px' }}>
                  {isFirstRun
                    ? 'Your number is linked. Next time you can sign in straight from the login page with Facebook.'
                    : 'Your number is linked and ready to send.'}
                </p>
              )}
              {/* onClose, not onConnected: onConnected already fired the moment
                  the save succeeded. Wiring Continue to it too made the parent
                  run its "connected" handler twice. */}
              <button onClick={onClose} style={primaryBtn(warning ? C.amber : '#25D366')}>Continue</button>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
                <Benefit icon={<Zap size={16} color="#1877f2" />} title="Fast, guided setup" text="Facebook walks you through picking your business and number." />
                <Benefit icon={<ShieldCheck size={16} color="#1877f2" />} title="Secure by design" text="We never see your password; tokens are exchanged server-side and encrypted." />
                {isFirstRun
                  ? <Benefit icon={<PlugZap size={16} color="#1877f2" />} title="One-tap sign-in later" text="Once connected, use “Sign in with Facebook” on the login page." />
                  : <Benefit icon={<PlugZap size={16} color="#1877f2" />} title="Ready to send" text="We register the number with Meta so it can send straight away." />}
              </div>

              {error && (
                <div style={{
                  background: 'rgba(239,68,68,0.12)', color: '#DC2626', borderRadius: 8,
                  padding: '10px 12px', fontSize: 12.5, marginBottom: 14, lineHeight: 1.5,
                }}>{error}</div>
              )}

              <button onClick={launch} disabled={busy} style={{ ...primaryBtn('#1877f2'), width: '100%', opacity: busy ? 0.75 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}>
                {busy ? <Loader2 size={16} style={{ animation: 'spin 0.7s linear infinite' }} /> : <FacebookGlyph />}
                {busy ? 'Connecting…' : 'Login with Facebook'}
              </button>
              <button onClick={onClose} disabled={busy} style={{
                width: '100%', marginTop: 10, padding: '10px', borderRadius: 10,
                background: 'transparent', border: 'none', color: C.textSecondary,
                fontSize: 13, fontWeight: 600, fontFamily: FONT, cursor: busy ? 'not-allowed' : 'pointer',
              }}>
                {isFirstRun ? 'I’ll do this later' : 'Cancel'}
              </button>
              {isFirstRun && (
                // Pointless when the modal was opened FROM that very screen.
                <p style={{ fontSize: 11, color: C.textMuted, textAlign: 'center', margin: '10px 0 0', lineHeight: 1.5 }}>
                  You can also connect manually anytime in Settings → WhatsApp Accounts.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Benefit({ icon, title, text }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{
        flexShrink: 0, width: 32, height: 32, borderRadius: 9, background: 'rgba(24,119,242,0.10)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{icon}</div>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>{title}</div>
        <div style={{ fontSize: 12.5, color: C.textSecondary, lineHeight: 1.45 }}>{text}</div>
      </div>
    </div>
  );
}

function GlyphBubble({ children }) {
  return (
    <div style={{
      width: 44, height: 44, borderRadius: 12, background: 'rgba(255,255,255,0.95)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
    }}>{children}</div>
  );
}

const primaryBtn = (bg) => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10,
  padding: '12px 20px', borderRadius: 10, border: 'none', background: bg, color: '#fff',
  fontSize: 14, fontWeight: 700, fontFamily: FONT, cursor: 'pointer',
});

function FacebookGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="#1877f2" aria-hidden="true">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}

function WhatsAppGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="#25D366" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}
