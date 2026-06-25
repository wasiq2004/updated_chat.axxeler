// Tenant audit log viewer (SaaS Phase 6). Read-only trail of sensitive actions
// in this tenant. Backend scopes it to the current tenant + audit.view perm.

import { useState, useEffect } from 'react';
import { ScrollText, Search, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, MONO } from '../constants.js';

// Color-code actions by area for quick scanning.
function actionColor(action = '') {
  if (action.includes('delete') || action.includes('suspend')) return '#DC2626';
  if (action.startsWith('platform.') || action.includes('impersonation')) return C.purple;
  if (action.includes('create')) return C.green;
  if (action.includes('branding') || action.includes('update') || action.includes('change')) return C.amber;
  return C.textSecondary;
}

export default function AuditPage() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');

  const load = () => {
    setRows(null);
    api.audit(200).then(setRows).catch(e => setError(e.message));
  };
  useEffect(() => { load(); }, []);

  const filtered = (rows || []).filter(r => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return [r.action, r.actor_username, r.target_type, r.target_id, r.ip_address]
      .some(v => String(v || '').toLowerCase().includes(s));
  });

  return (
    <div style={{ padding: '28px 32px 48px', fontFamily: FONT, color: C.text, maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div>
          <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.primary }}>Security</div>
          <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0, letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
            <ScrollText size={24} color={C.textSecondary} /> Audit log
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} color={C.textMuted} style={{ position: 'absolute', left: 11, top: 11 }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter…"
              style={{ padding: '8px 12px 8px 32px', borderRadius: 9, border: `1px solid ${C.border}`, background: C.surfaceAlt, color: C.text, fontFamily: FONT, fontSize: 13, width: 200 }} />
          </div>
          <button onClick={load} title="Refresh" style={{ width: 36, height: 36, borderRadius: 9, border: `1px solid ${C.border}`, background: C.cardBg, color: C.textSecondary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {error && <div style={{ color: '#DC2626', background: '#DC26261a', border: '1px solid #DC262633', borderRadius: 9, padding: '10px 12px', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <div style={{ background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden', boxShadow: C.shadowSm }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: C.surfaceAlt, textAlign: 'left', color: C.textSecondary }}>
              {['When', 'Actor', 'Action', 'Target', 'IP'].map(h => (
                <th key={h} style={{ padding: '11px 14px', fontWeight: 600, fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows == null ? (
              <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: C.textMuted }}>Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: C.textMuted }}>No audit entries{q ? ' match your filter' : ' yet'}.</td></tr>
            ) : filtered.map(r => (
              <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
                <td style={{ padding: '10px 14px', color: C.textSecondary, whiteSpace: 'nowrap' }}>{new Date(r.created_at).toLocaleString()}</td>
                <td style={{ padding: '10px 14px', fontWeight: 600 }}>{r.actor_username || r.actor_user_id || '—'}</td>
                <td style={{ padding: '10px 14px' }}>
                  <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: actionColor(r.action), background: `${actionColor(r.action)}14`, padding: '3px 8px', borderRadius: 6 }}>
                    {r.action}
                  </span>
                </td>
                <td style={{ padding: '10px 14px', color: C.textSecondary }}>{r.target_type ? `${r.target_type}#${r.target_id}` : '—'}</td>
                <td style={{ padding: '10px 14px', color: C.textMuted, fontFamily: MONO, fontSize: 12 }}>{r.ip_address || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
