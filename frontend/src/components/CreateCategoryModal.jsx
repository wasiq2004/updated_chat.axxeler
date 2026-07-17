import { useState, useEffect } from 'react';
import { X, Loader2, Check } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

/**
 * Inline "create category", opened from Manage Tags.
 *
 * A tag cannot exist without a category (tags.category_id is NOT NULL), so
 * without this the first person who needs a new grouping is stuck: they'd have
 * to leave Lead Studio for Settings, which is the exact trip this feature
 * removes.
 *
 * MUST be rendered as a SIBLING of ManageTagsModal, never a child. Nested inside
 * it, a click on THIS backdrop bubbles to the parent's click-to-close overlay
 * and shuts the modal underneath — the user cancels a category and the whole
 * tag manager vanishes.
 *
 * Props: onClose(), onCreated(category)
 */
export default function CreateCategoryModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Reset on OPEN only. This component is mounted fresh each time, so this is
  // belt-and-braces — but it also documents why there is no `tags`/`categories`
  // dependency here: resetting on a refetched array would wipe what's being typed.
  useEffect(() => { setName(''); setDescription(''); setBusy(false); setError(''); }, []);

  const save = async () => {
    if (!name.trim()) { setError('Give the category a name.'); return; }
    setBusy(true);
    setError('');
    try {
      const cat = await api.categories.create({ name: name.trim(), description: description.trim() });
      onCreated(cat);
    } catch (e) {
      setError(/permission|403/i.test(e?.message || '') ? 'You don’t have permission to create categories.' : (e?.message || 'Could not create the category.'));
    } finally {
      // Cleared in BOTH paths — a stuck flag disables the form forever.
      setBusy(false);
    }
  };

  return (
    <div
      // zIndex above ManageTagsModal's 300 — it sits on top, not behind.
      style={{
        position: 'fixed', inset: 0, zIndex: 400, fontFamily: FONT,
        background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label="New category" style={{
        width: '100%', maxWidth: 400, background: C.cardBg,
        borderRadius: 14, border: `1px solid ${C.border}`, padding: '18px 20px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>New category</div>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textSecondary, display: 'flex' }}>
            <X size={17} />
          </button>
        </div>

        {error && (
          <div role="alert" style={{
            background: 'rgba(239,68,68,.12)', color: '#DC2626', borderRadius: 8,
            padding: '9px 12px', fontSize: 12.5, marginBottom: 12, fontWeight: 500,
          }}>{error}</div>
        )}

        <input
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); }}
          placeholder="e.g. Lead Source"
          autoFocus
          style={{ ...inputStyle, marginBottom: 10 }}
        />
        <input
          value={description}
          onChange={e => setDescription(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); }}
          placeholder="Description (optional)"
          style={{ ...inputStyle, marginBottom: 14 }}
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy} style={{
            padding: '8px 12px', borderRadius: 8, border: `1px solid ${C.border}`,
            background: C.cardBg, color: C.text, fontSize: 12.5, fontFamily: FONT, fontWeight: 600, cursor: 'pointer',
          }}>Cancel</button>
          <button type="button" onClick={save} disabled={busy} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 13px', borderRadius: 8, border: 'none',
            background: C.primary, color: '#fff', fontSize: 12.5, fontFamily: FONT, fontWeight: 700,
            cursor: 'pointer', opacity: busy ? 0.7 : 1,
          }}>
            {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '9px 11px', borderRadius: 8,
  border: `1px solid ${C.border}`, fontSize: 13, fontFamily: FONT,
  color: C.text, background: C.cardBg, outline: 'none', boxSizing: 'border-box',
};
