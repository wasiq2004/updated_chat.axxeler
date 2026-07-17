import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Loader2, FileSpreadsheet, AlertTriangle, Check } from 'lucide-react';
import { api } from '../../api.js';
import { C, FONT, MONO } from '../../constants.js';
import { useSheetPicker } from '../SheetPicker.jsx';
import DeleteConfirmModal from '../DeleteConfirmModal.jsx';

/**
 * Integrations → Saved Sheets.
 *
 * Connect a spreadsheet + tab once, name it, and it appears by name in every
 * sheet picker in the automation builder — instead of walking
 * account → spreadsheet → tab on every single step.
 *
 * Deleting an entry is safe: pickers COPY the resolved ids onto the node, so a
 * flow already using it keeps working. The entry just stops being offered.
 */
export default function SavedSheetsTab({ user }) {
  const isAdmin = user?.role === 'admin';
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRows(await api.savedSheets.list());
    } catch (e) {
      setError(e.message || 'Could not load saved sheets');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const remove = async (row) => {
    try {
      await api.savedSheets.delete(row.id);
      setPendingDelete(null);
      await refresh();
    } catch (e) {
      setError(e.message || 'Could not delete');
      setPendingDelete(null);
    }
  };

  return (
    <div style={{ flex: 1, padding: '32px 40px', overflowY: 'auto', fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 22, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em' }}>Saved Sheets</h1>
          <p style={{ fontSize: 12, color: C.textMuted, margin: '4px 0 0', maxWidth: 620, lineHeight: 1.55 }}>
            Set a spreadsheet up once and give it a name. It then shows up by name in every
            automation step that touches a sheet, so nobody has to go hunting for it again.
          </p>
        </div>
        {isAdmin && !adding && (
          <button onClick={() => setAdding(true)} style={primaryBtn}><Plus size={14} /> Save a sheet</button>
        )}
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, marginBottom: 16, maxWidth: 820,
          background: 'rgba(239,68,68,.14)', color: '#DC2626', border: '1px solid rgba(239,68,68,.3)', fontSize: 13,
        }}>{error}</div>
      )}

      {adding && (
        <AddSavedSheet
          onCancel={() => setAdding(false)}
          onSaved={async () => { setAdding(false); await refresh(); }}
          onError={setError}
        />
      )}

      {loading && rows.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 40, color: C.textMuted, fontSize: 13 }}>
          <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Loading…
        </div>
      ) : rows.length === 0 && !adding ? (
        <EmptyState isAdmin={isAdmin} onAdd={() => setAdding(true)} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 820 }}>
          {rows.map(r => (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 16px', background: C.cardBg, borderRadius: 10,
              border: `1px solid ${C.border}`, gap: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <div style={{
                  width: 34, height: 34, borderRadius: 9, background: C.primaryLight,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <FileSpreadsheet size={17} color={C.primary} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{r.name}</div>
                  <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.spreadsheetName || r.spreadsheetId} · <span style={{ fontFamily: MONO }}>{r.sheetName}</span>
                    {r.googleAccountLabel && <> · {r.googleAccountLabel}</>}
                  </div>
                  {r.accountHealth === 'error' && (
                    // Worth saying before someone builds a flow on a dead credential.
                    <div style={{ fontSize: 11, color: '#B45309', fontWeight: 700, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <AlertTriangle size={11} /> This Google account needs reconnecting
                    </div>
                  )}
                </div>
              </div>
              {isAdmin && (
                <button onClick={() => setPendingDelete(r)} title="Remove from the picker"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderRadius: 8,
                    border: `1px solid ${C.border}`, background: C.cardBg,
                    color: C.primary, fontSize: 12, fontFamily: FONT, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
                  }}>
                  <Trash2 size={13} /> Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <DeleteConfirmModal
        open={!!pendingDelete}
        title={pendingDelete ? `Remove “${pendingDelete.name}”?` : ''}
        // The honest promise: this is genuinely safe, because the ids were
        // copied onto each node when it was picked.
        message="It disappears from the sheet pickers. Automations already using it keep working — they hold their own copy of the link."
        confirmText="Remove"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => remove(pendingDelete)}
      />
    </div>
  );
}

function AddSavedSheet({ onCancel, onSaved, onError }) {
  const [name, setName] = useState('');
  const [googleAccountId, setGoogleAccountId] = useState('');
  const [spreadsheetId, setSpreadsheetId] = useState('');
  const [spreadsheetName, setSpreadsheetName] = useState('');
  const [sheetName, setSheetName] = useState('');
  const [saving, setSaving] = useState(false);

  const { accounts, spreadsheets, tabs, scopeMissing } = useSheetPicker({ googleAccountId, spreadsheetId, sheetName });

  const save = async () => {
    if (!name.trim()) { onError('Give it a name — that’s what people will pick.'); return; }
    if (!googleAccountId || !spreadsheetId || !sheetName) { onError('Pick an account, spreadsheet and tab.'); return; }
    setSaving(true);
    onError('');
    try {
      await api.savedSheets.create({ name: name.trim(), googleAccountId, spreadsheetId, spreadsheetName, sheetName });
      onSaved();
    } catch (e) {
      onError(e.message || 'Could not save');
    } finally {
      // Cleared in both paths — a stuck flag disables the form for good.
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: 18, borderRadius: 12, background: C.cardBg, border: `1px solid ${C.border}`, marginBottom: 18, maxWidth: 620 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>Save a sheet</div>

      <FieldLabel>Name *</FieldLabel>
      <input value={name} onChange={e => setName(e.target.value)}
        placeholder="e.g. Enquiries tracker" style={{ ...inputStyle, marginBottom: 14 }} />

      <FieldLabel>Google account *</FieldLabel>
      <select value={googleAccountId}
        onChange={e => { setGoogleAccountId(e.target.value); setSpreadsheetId(''); setSheetName(''); }}
        style={{ ...inputStyle, marginBottom: 14 }}>
        <option value="">— Pick an account —</option>
        {accounts.map(a => <option key={a.id} value={a.id}>{a.accountLabel || a.account_label}</option>)}
      </select>

      {scopeMissing ? (
        <div style={{
          padding: '10px 12px', borderRadius: 8, marginBottom: 14,
          background: 'rgba(245,158,11,.12)', color: '#B45309', border: '1px solid rgba(245,158,11,.3)',
          fontSize: 12, lineHeight: 1.55,
        }}>
          This account was connected without permission to list your spreadsheets, so they can’t be
          browsed here. Reconnect it under Integrations → Google.
        </div>
      ) : (
        <>
          <FieldLabel>Spreadsheet *</FieldLabel>
          <select value={spreadsheetId}
            onChange={e => {
              const sel = spreadsheets.find(s => s.id === e.target.value);
              setSpreadsheetId(e.target.value);
              setSpreadsheetName(sel?.name || '');
              setSheetName('');
            }}
            disabled={!googleAccountId}
            style={{ ...inputStyle, marginBottom: 14 }}>
            <option value="">— Pick a spreadsheet —</option>
            {spreadsheets.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>

          <FieldLabel>Tab *</FieldLabel>
          <select value={sheetName} onChange={e => setSheetName(e.target.value)}
            disabled={!spreadsheetId} style={{ ...inputStyle, marginBottom: 18 }}>
            <option value="">— Pick a tab —</option>
            {tabs.map(t => <option key={t.sheetId} value={t.title}>{t.title}</option>)}
          </select>
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onCancel} disabled={saving} style={ghostBtn}>Cancel</button>
        <button onClick={save} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.7 : 1 }}>
          {saving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />}
          Save sheet
        </button>
      </div>
    </div>
  );
}

function EmptyState({ isAdmin, onAdd }) {
  return (
    <div style={{
      padding: 32, borderRadius: 12, background: 'var(--c-surfaceAlt)',
      border: `1px dashed ${C.border}`, textAlign: 'center', maxWidth: 820,
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: 13, margin: '0 auto 14px', background: C.primaryLight,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <FileSpreadsheet size={26} color={C.primary} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 6 }}>No saved sheets yet</div>
      <p style={{ fontSize: 13, color: C.textSecondary, margin: '0 0 18px', lineHeight: 1.55 }}>
        {isAdmin
          ? 'Save the sheets your team uses often, so they can be picked by name in any automation.'
          : 'An admin can save the sheets your team uses often, so they’re pickable by name here.'}
      </p>
      {isAdmin && <button onClick={onAdd} style={{ ...primaryBtn, margin: '0 auto' }}><Plus size={14} /> Save a sheet</button>}
    </div>
  );
}

function FieldLabel({ children }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: C.textSecondary,
      textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6,
    }}>{children}</div>
  );
}

const inputStyle = {
  width: '100%', padding: '10px 12px', borderRadius: 8,
  border: `1px solid ${C.border}`, fontSize: 14, fontFamily: FONT,
  color: C.text, background: C.cardBg, outline: 'none', boxSizing: 'border-box',
};
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '9px 14px', borderRadius: 8, border: 'none',
  background: C.primary, color: '#fff', fontSize: 13, fontFamily: FONT, fontWeight: 700, cursor: 'pointer',
};
const ghostBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '9px 12px', borderRadius: 8, border: `1px solid ${C.border}`,
  background: C.cardBg, color: C.text, fontSize: 12, fontFamily: FONT, fontWeight: 600, cursor: 'pointer',
};
