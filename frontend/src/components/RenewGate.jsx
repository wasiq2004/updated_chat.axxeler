// Full-screen "subscription expired" gate. Shown to a tenant whose plan has
// passed the grace window (entitlements.subscription.locked). Plan changes are
// made by the platform super admin, so this is a prompt to renew, not a
// self-serve checkout. The Billing page stays reachable so the user can review
// their plan and usage.

import { Lock } from 'lucide-react';
import { C, FONT } from '../constants.js';

export default function RenewGate({ onViewBilling }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 28, fontFamily: FONT,
    }}>
      <div style={{
        maxWidth: 480, width: '100%', textAlign: 'center',
        background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 20,
        padding: '40px 32px', boxShadow: C.shadowSm,
      }}>
        <span style={{
          width: 64, height: 64, borderRadius: 16, background: '#DC26261a',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18,
        }}>
          <Lock size={30} color="#DC2626" />
        </span>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 10px' }}>Your subscription has expired</h1>
        <p style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.6, margin: '0 0 24px' }}>
          Your plan’s grace period has ended, so premium features are locked. Renew
          your subscription to restore access. Reach out to your account manager to
          reactivate your plan.
        </p>
        <button onClick={onViewBilling} style={{
          padding: '11px 22px', borderRadius: 10, border: 'none', background: C.primary,
          color: '#fff', fontFamily: FONT, fontSize: 14, fontWeight: 700, cursor: 'pointer',
        }}>
          View plan & billing
        </button>
      </div>
    </div>
  );
}
