import { useState, useEffect } from 'react';
import { X, Plus, Pencil, Trash2, Loader2, FolderPlus, Check } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT, darkenColor } from '../constants.js';

/**
 * Manage tags — from Lead Studio, where tags are actually applied.
 *
 * This lived in Settings, two clicks away from the only place anyone uses it,
 * and behind a permission ('admin-settings:tags') that the people doing the
 * tagging don't have. Tag CRUD is now gated on 'contacts' instead.
 *
 * Four traps are deliberately designed around here — each was a real bug:
 *
 *  1. A form modal rendered INSIDE a click-to-close overlay bubbles backdrop
 *     clicks and closes the parent underneath it. The category form is a SIBLING
 *     of this modal (rendered by the parent), never a child.
 *  2. A form that resets on a prop whose IDENTITY changes (a refetched array)
 *     wipes what the user is typing. Reset on OPEN only — never on `tags`.
 *  3. A `saving` flag set true and cleared only in the error path never resets on
 *     success, and hiding a component by returning null does NOT unmount it — so
 *     the form stays disabled forever. Reset it on open, and clear it in both
 *     paths.
 *  4. A "filter" select needs an explicit "All" — a placeholder isn't selectable,
 *     so the filter can't be undone.
 *
 * Props:
 *   categories, tags — current lists
 *   onClose()
 *   onChanged()      — something was created/edited/deleted; parent refetches
 *   onCreateCategory() — opens the parent's sibling category form (trap 1)
 */
export default function ManageTagsModal({ categories = [], tags = [], onClose, onChanged, onCreateCategory }) {
  const [editing, setEditing] = useState(null);   // tag row, or {} for new
  const [name, setName] = useState('');
  const [color, setColor] = useState('#dc2626');
  const [categoryId, setCategoryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);

  // Trap 2 + 3: reset on OPEN of the form only — keyed on the tag's identity,
  // NOT on `tags` (which changes identity on every refetch and would wipe the
  // half-typed name the moment a category was created inline).
  useEffect(() => {
    if (!editing) return;
    setName(editing.name || '');
    setColor(editing.color || '#dc2626');
    setCategoryId(editing.category_id || categories[0]?.id || '');
    setBusy(false);   // trap 3: a stuck `saving` from a previous attempt
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id, editing === null]);

  const save = async () => {
    if (!name.trim()) { setError('Give the tag a name.'); return; }
    // A tag cannot exist without a category — tags.category_id is NOT NULL.
    if (!categoryId) { setError('Pick a category, or create one first.'); return; }
    setBusy(true);
    setError('');
    try {
      const payload = { name: name.trim(), color, categoryId };
      if (editing.id) await api.tags.update(editing.id, payload);
      else await api.tags.create(payload);
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(prettyError(e));
    } finally {
      // Trap 3: cleared in BOTH paths.
      setBusy(false);
    }
  };

  const remove = async (tag) => {
    setBusy(true);
    setError('');
    try {
      await api.tags.delete(tag.id);
      setConfirmDelete(null);
      onChanged();
    } catch (e) {
      setError(prettyError(e));
    } finally {
      setBusy(false);
    }
  };

  const byCategory = categories.map(cat => ({
    cat,
    rows: tags.filter(t => t.category_id === cat.id),
  }));
  const orphans = tags.filter(t => !categories.some(c => c.id === t.category_id));

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 300, fontFamily: FONT,
        background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Manage tags"
        style={{
          width: '100%', maxWidth: 560, maxHeight: '88vh', overflowY: 'auto',
          background: C.cardBg, borderRadius: 14, border: `1px solid ${C.border}`,
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, background: C.cardBg,
        }}>
          <div style={{ fontSize: 15.5, fontWeight: 800, color: C.text }}>Manage tags</div>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textSecondary, display: 'flex' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '16px 20px 20px' }}>
          {error && (
            <div role="alert" style={{
              background: 'rgba(239,68,68,.12)', color: '#DC2626', borderRadius: 8,
              padding: '9px 12px', fontSize: 12.5, marginBottom: 12, fontWeight: 500,
            }}>{error}</div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button type="button" onClick={() => setEditing({})} disabled={categories.length === 0}
              title={categories.length === 0 ? 'Create a category first — a tag must belong to one' : undefined}
              style={{ ...primaryBtn, opacity: categories.length === 0 ? 0.5 : 1 }}>
              <Plus size={14} /> New tag
            </button>
            {/* Trap 1: this asks the PARENT to open its own sibling modal. */}
            <button type="button" onClick={onCreateCategory} style={ghostBtn}>
              <FolderPlus size={14} /> New category
            </button>
          </div>

          {editing && (
            <div style={{
              padding: 14, borderRadius: 10, marginBottom: 16,
              background: 'var(--c-surfaceAlt)', border: `1px solid ${C.border}`,
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>
                {editing.id ? 'Edit tag' : 'New tag'}
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') save(); }}
                  placeholder="Tag name"
                  autoFocus
                  style={{ ...inputStyle, flex: 1, minWidth: 150 }}
                />
                <input
                  type="color"
                  value={color}
                  onChange={e => setColor(e.target.value)}
                  aria-label="Tag colour"
                  title="Tag colour"
                  style={{ width: 44, height: 38, padding: 2, borderRadius: 8, border: `1px solid ${C.border}`, background: C.cardBg, cursor: 'pointer' }}
                />
              </div>
              <select
                value={categoryId}
                onChange={e => setCategoryId(e.target.value)}
                aria-label="Category"
                style={{ ...inputStyle, marginBottom: 12 }}
              >
                {/* Not a filter — a required field. An unselectable placeholder
                    is correct here precisely because blank is invalid. */}
                <option value="">— Pick a category —</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" onClick={() => setEditing(null)} disabled={busy} style={ghostBtn}>Cancel</button>
                <button type="button" onClick={save} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.7 : 1 }}>
                  {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />}
                  {editing.id ? 'Save' : 'Create'}
                </button>
              </div>
            </div>
          )}

          {categories.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: C.textMuted, fontSize: 13, lineHeight: 1.6 }}>
              No categories yet. A tag has to live in one — create a category to start.
            </div>
          )}

          {byCategory.map(({ cat, rows }) => (
            <div key={cat.id} style={{ marginBottom: 16 }}>
              <div style={{
                fontSize: 10.5, fontWeight: 800, color: C.textMuted,
                textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 7,
              }}>{cat.name}</div>
              {rows.length === 0 ? (
                <div style={{ fontSize: 12, color: C.textMuted, padding: '4px 0' }}>No tags in this category yet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {rows.map(t => (
                    <TagRow key={t.id} tag={t} busy={busy}
                      onEdit={() => setEditing(t)}
                      onDelete={() => setConfirmDelete(t)} />
                  ))}
                </div>
              )}
            </div>
          ))}

          {orphans.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, color: '#B45309', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 7 }}>
                Category missing
              </div>
              {/* Shouldn't happen (the FK cascades), but if it does, hiding them
                  would make them uneditable and invisible. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {orphans.map(t => (
                  <TagRow key={t.id} tag={t} busy={busy} onEdit={() => setEditing(t)} onDelete={() => setConfirmDelete(t)} />
                ))}
              </div>
            </div>
          )}
        </div>

        {confirmDelete && (
          <div style={{
            position: 'sticky', bottom: 0, padding: '14px 20px',
            background: C.cardBg, borderTop: `1px solid ${C.border}`,
          }}>
            <div style={{ fontSize: 13, color: C.text, marginBottom: 4, fontWeight: 700 }}>
              Delete “{confirmDelete.name}”?
            </div>
            <div style={{ fontSize: 12, color: C.textSecondary, marginBottom: 10, lineHeight: 1.5 }}>
              It’s removed from the tag list. Leads already carrying it keep the label until they’re next saved.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => setConfirmDelete(null)} disabled={busy} style={ghostBtn}>Cancel</button>
              <button type="button" onClick={() => remove(confirmDelete)} disabled={busy}
                style={{ ...primaryBtn, background: '#DC2626', opacity: busy ? 0.7 : 1 }}>
                {busy ? 'Deleting…' : 'Delete tag'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TagRow({ tag, busy, onEdit, onDelete }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '7px 10px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.cardBg,
    }}>
      <span style={{
        padding: '2px 9px', borderRadius: 20, fontSize: 11.5, fontWeight: 700,
        background: darkenColor(tag.color), color: '#fff', flexShrink: 0,
      }}>{tag.name}</span>
      <span style={{ flex: 1 }} />
      <button type="button" onClick={onEdit} disabled={busy} aria-label={`Edit ${tag.name}`}
        style={iconBtn}><Pencil size={13} /></button>
      <button type="button" onClick={onDelete} disabled={busy} aria-label={`Delete ${tag.name}`}
        style={{ ...iconBtn, color: '#DC2626' }}><Trash2 size={13} /></button>
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '9px 11px', borderRadius: 8,
  border: `1px solid ${C.border}`, fontSize: 13, fontFamily: FONT,
  color: C.text, background: C.cardBg, outline: 'none', boxSizing: 'border-box',
};
const primaryBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 13px', borderRadius: 8, border: 'none',
  background: C.primary, color: '#fff', fontSize: 12.5, fontFamily: FONT, fontWeight: 700, cursor: 'pointer',
};
const ghostBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 12px', borderRadius: 8, border: `1px solid ${C.border}`,
  background: C.cardBg, color: C.text, fontSize: 12.5, fontFamily: FONT, fontWeight: 600, cursor: 'pointer',
};
const iconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  padding: 6, borderRadius: 6, border: `1px solid ${C.border}`,
  background: C.cardBg, color: C.textSecondary, cursor: 'pointer',
};

function prettyError(e) {
  const msg = e?.message || String(e || 'Unknown error');
  // The API layer throws with the server's { error } string already extracted.
  if (/permission|forbidden|403/i.test(msg)) return 'You don’t have permission to change tags.';
  return msg;
}
