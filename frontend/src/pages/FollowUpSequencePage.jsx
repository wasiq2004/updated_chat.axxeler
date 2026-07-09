// Follow-up sequences: timed template drips. Contacts are enrolled via the
// "Start Sequence" automation action (or paused/ended the same way); the
// backend sweeper sends each due step. This page is the CRUD for the drips
// themselves: name, on/off, and the ordered steps (template + delay).

import { useState, useEffect, useCallback } from 'react';
import { ListChecks, Plus, Trash2, Pencil, X, Check } from 'lucide-react';
import { api } from '../api.js';
import { C, FONT } from '../constants.js';

const card = {
  background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 14,
  padding: 18, boxShadow: C.shadowSm,
};
const btn = {
  padding: '8px 14px', borderRadius: 9, border: `1px solid ${C.border}`,
  background: C.cardBg, color: C.text, fontFamily: FONT, fontSize: 13,
  fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
};
const btnPrimary = { ...btn, background: C.primary, color: '#fff', border: 'none' };
const inp = {
  padding: '8px 11px', borderRadius: 9, border: `1px solid ${C.border}`,
  fontFamily: FONT, fontSize: 13, background: C.cardBg, color: C.text, width: '100%',
};

const UNITS = ['minutes', 'hours', 'days'];

export default function FollowUpSequencePage() {
  const [sequences, setSequences] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [editing, setEditing] = useState(null); // sequence object or {} for new
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api.sequences.list().then(setSequences).catch(e => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    api.templates.list().then(tpls => {
      setTemplates((tpls || []).filter(t => String(t.status || '').toUpperCase() === 'APPROVED'));
    }).catch(() => setTemplates([]));
  }, [load]);

  const remove = async (s) => {
    if (!window.confirm(`Delete the sequence "${s.name}"? Active enrollments stop immediately.`)) return;
    try { await api.sequences.remove(s.id); load(); } catch (e) { setError(e.message); }
  };
  const toggleActive = async (s) => {
    try { await api.sequences.update(s.id, { isActive: !s.isActive }); load(); } catch (e) { setError(e.message); }
  };

  return (
    <div style={{ padding: '26px 30px', fontFamily: FONT, color: C.text, maxWidth: 980, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 18, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 25, fontWeight: 800, margin: 0, letterSpacing: '-.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
            <ListChecks size={22} style={{ color: C.primary }} /> Follow-ups
          </h1>
          <p style={{ fontSize: 13, color: C.textSecondary, margin: '6px 0 0' }}>
            Timed template drips. Enroll contacts with the <b>Start Sequence</b> action in any automation.
          </p>
        </div>
        <button style={btnPrimary} onClick={() => setEditing({})}><Plus size={15} /> New sequence</button>
      </div>

      {error && (
        <div style={{ color: C.error, background: 'rgba(220,38,38,.10)', border: '1px solid rgba(220,38,38,.20)', borderRadius: 9, padding: '10px 12px', fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {sequences === null ? (
        <div style={{ color: C.textMuted, fontSize: 14, padding: 30 }}>Loading…</div>
      ) : sequences.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', padding: 44, color: C.textSecondary, fontSize: 14 }}>
          No sequences yet. Create one, then add a <b>Start Sequence</b> action to an automation to enroll contacts.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {sequences.map(s => (
            <div key={s.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 15, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {s.name}
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99, textTransform: 'uppercase', letterSpacing: '.06em',
                    background: s.isActive ? 'rgba(22,163,74,.12)' : 'rgba(100,116,139,.12)',
                    color: s.isActive ? C.green : C.textMuted,
                  }}>{s.isActive ? 'On' : 'Off'}</span>
                </div>
                {s.description && <div style={{ fontSize: 12.5, color: C.textSecondary, marginTop: 3 }}>{s.description}</div>}
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 5 }}>
                  {s.steps.length} step{s.steps.length === 1 ? '' : 's'} · {s.active} active · {s.completed} completed
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={btn} onClick={() => toggleActive(s)}>{s.isActive ? 'Turn off' : 'Turn on'}</button>
                <button style={btn} onClick={() => setEditing(s)}><Pencil size={14} /> Edit</button>
                <button style={{ ...btn, color: C.error }} onClick={() => remove(s)}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <SequenceEditor
          sequence={editing} templates={templates}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function SequenceEditor({ sequence, templates, onClose, onSaved }) {
  const isNew = !sequence.id;
  const [name, setName] = useState(sequence.name || '');
  const [description, setDescription] = useState(sequence.description || '');
  const [steps, setSteps] = useState(
    (sequence.steps && sequence.steps.length ? sequence.steps : [{ templateId: '', delayValue: 1, delayUnit: 'hours' }])
      .map(s => ({ templateId: s.templateId || '', delayValue: s.delayValue ?? 1, delayUnit: s.delayUnit || 'hours' }))
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const setStep = (i, patch) => setSteps(prev => prev.map((s, j) => j === i ? { ...s, ...patch } : s));
  const addStep = () => setSteps(prev => [...prev, { templateId: '', delayValue: 1, delayUnit: 'days' }]);
  const delStep = (i) => setSteps(prev => prev.filter((_, j) => j !== i));

  async function save() {
    if (!name.trim()) { setErr('Name is required'); return; }
    const clean = steps.filter(s => s.templateId);
    if (clean.length === 0) { setErr('Add at least one step with a template'); return; }
    setBusy(true); setErr(null);
    try {
      const payload = { name: name.trim(), description: description || null, steps: clean };
      if (isNew) await api.sequences.create(payload);
      else await api.sequences.update(sequence.id, payload);
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 300,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: FONT,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(620px, 100%)', maxHeight: '86vh', overflowY: 'auto',
        background: C.cardBg, border: `1px solid ${C.border}`, borderRadius: 16, boxShadow: C.shadowLg, padding: 22,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 17, fontWeight: 800 }}>{isNew ? 'New sequence' : `Edit "${sequence.name}"`}</div>
          <button onClick={onClose} style={{ ...btn, padding: 7 }}><X size={15} /></button>
        </div>
        {err && <div style={{ color: C.error, background: 'rgba(220,38,38,.10)', border: '1px solid rgba(220,38,38,.20)', borderRadius: 9, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>{err}</div>}

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 5 }}>Name</div>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. New lead nurture" style={inp} maxLength={200} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 5 }}>Description (optional)</div>
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="What this drip is for" style={inp} />
        </div>

        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Steps</div>
        <div style={{ fontSize: 11.5, color: C.textMuted, marginBottom: 10 }}>
          Each step sends an approved template after its delay (counted from the previous step, or from enrollment for step 1).
        </div>
        {steps.map((s, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, width: 18 }}>{i + 1}.</span>
            <span style={{ fontSize: 12, color: C.textSecondary }}>after</span>
            <input type="number" min={0} value={s.delayValue}
              onChange={e => setStep(i, { delayValue: Math.max(0, parseInt(e.target.value, 10) || 0) })}
              style={{ ...inp, width: 70 }} />
            <select value={s.delayUnit} onChange={e => setStep(i, { delayUnit: e.target.value })} style={{ ...inp, width: 100 }}>
              {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
            <span style={{ fontSize: 12, color: C.textSecondary }}>send</span>
            <select value={s.templateId} onChange={e => setStep(i, { templateId: e.target.value })} style={{ ...inp, flex: 1, minWidth: 160 }}>
              <option value="">— pick template —</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button onClick={() => delStep(i)} style={{ ...btn, padding: 7, color: C.error }}><Trash2 size={13} /></button>
          </div>
        ))}
        <button onClick={addStep} style={{ ...btn, marginTop: 4 }}><Plus size={14} /> Add step</button>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={btnPrimary} onClick={save} disabled={busy}><Check size={15} /> {busy ? 'Saving…' : 'Save sequence'}</button>
        </div>
      </div>
    </div>
  );
}
