import { useState, useEffect, useCallback, useMemo } from 'react';
import { Users, Search, Phone, User, Pencil, Trash2, Loader2, X, Send, Play, Music, FileText, Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Download } from 'lucide-react';
import DeleteConfirmModal from '../components/DeleteConfirmModal.jsx';
import WhatsAppPreview, { BroadcastMessagePreview } from '../components/WhatsAppPreview.jsx';
import TagMultiSelect from '../components/TagMultiSelect.jsx';
import ManageTagsModal from '../components/ManageTagsModal.jsx';
import CreateCategoryModal from '../components/CreateCategoryModal.jsx';
import { CustomFieldEditor, CustomFieldView } from '../components/CustomFieldInputs.jsx';
import { api } from '../api.js';
import { C, FONT, MONO, maskPhone, darkenColor } from '../constants.js';
import MaskedNumber from '../components/MaskedNumber.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';

const ROLE_LABEL_MAP = { admin: 'Admin', bda_sales: 'Sales', viewer: 'Viewer' };

/* ── Lead Studio ────────────────────────────────────────────────────────────
   Everything below reuses data the list endpoint ALREADY returns — score from
   custom_fields, source from the lead-source tag category, owner from the
   assignment, recency from created_at. No new backend. */

// The score the "Update Lead Score" automation action writes. It lives in the
// custom_fields JSONB under the literal key `lead_score` and is stored as a
// STRING ("15"), not a number — so it needs parsing, and "0" must stay 0 rather
// than become null.
function leadScore(contact) {
  const raw = contact?.custom_fields?.lead_score;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

const HOT_SCORE = 70;

// The lead-source category, matched by NAME (the backend does the same, and
// makes it configurable via LEAD_SOURCE_CATEGORY). There is no schema-level
// "source" — it's a tag category convention.
function findLeadSourceCategory(categories) {
  return categories.find(c => /^lead\s*source$/i.test(String(c.name || '').trim())) || null;
}

function leadSourceTag(contact, sourceCatId) {
  if (!sourceCatId) return null;
  return (contact.tags || []).find(t => t.category_id === sourceCatId) || null;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// ONE definition per segment, used by both the chip's count and the filter.
// Two predicates would let a chip claim "12" and then show 9 — the count and
// the result must be the same question asked once.
const SEGMENTS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'new', label: 'New this week', match: c => !!c.created_at && new Date(c.created_at) >= daysAgo(7) },
  { key: 'hot', label: 'Hot', match: c => (leadScore(c) ?? -1) >= HOT_SCORE },
  { key: 'unassigned', label: 'Unassigned', match: c => !c.assigned_user_id },
  { key: 'unscored', label: 'Unscored', match: c => leadScore(c) === null },
];

function Kpi({ label, value, tone, hint }) {
  // The value stays ink-coloured whatever the tone — a number rendered in amber
  // or green on a light card fails contrast, and the tone is a hint, not the
  // information. The label carries the meaning.
  const accent = tone === 'good' ? '#0b7a3b' : tone === 'warn' ? '#B45309' : C.textMuted;
  return (
    <div title={hint} style={{
      flex: '1 1 130px', minWidth: 120, padding: '10px 13px', borderRadius: 10,
      background: 'var(--c-cardBg)', border: `1px solid ${C.border}`, fontFamily: FONT,
    }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: accent, textTransform: 'uppercase', letterSpacing: '.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 21, fontWeight: 800, color: C.text, marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </div>
  );
}

function SortableTh({ label, col, sortBy, sortDir, onSort, align = 'left' }) {
  const on = sortBy === col;
  return (
    <th style={{ padding: 0, textAlign: align, borderBottom: `1px solid ${C.border}` }}>
      {/* A real button: sorting must be keyboard-reachable, and a th with an
          onClick announces as nothing. */}
      <button
        type="button"
        onClick={() => onSort(col)}
        aria-sort={on ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
        style={{
          width: '100%', padding: '12px 16px', background: 'none', border: 'none',
          cursor: 'pointer', fontFamily: FONT, fontSize: 13, fontWeight: 600,
          color: on ? C.text : C.textSecondary,
          display: 'flex', alignItems: 'center', gap: 4,
          justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        }}
      >
        {label}
        <span aria-hidden="true" style={{ fontSize: 9, opacity: on ? 1 : 0.35 }}>
          {on ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

function ScoreCell({ score }) {
  // An unscored lead is NOT a zero. Rendering 0 would say "we assessed them and
  // they're worthless" instead of "nobody has scored them".
  if (score === null) return <span style={{ color: C.textMuted, fontSize: 12 }}>—</span>;
  const hot = score >= HOT_SCORE;
  return (
    <span style={{
      display: 'inline-block', minWidth: 30, padding: '2px 8px', borderRadius: 20,
      fontSize: 12, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
      background: hot ? 'rgba(37,211,102,.16)' : 'var(--c-surfaceAlt)',
      color: hot ? '#0b7a3b' : C.textSecondary,
    }}>{score}</span>
  );
}

function OwnerChip({ name, role }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
      <span style={{
        width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
        background: C.primaryLight, color: C.primary,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 10, fontWeight: 800,
      }}>{String(name).charAt(0).toUpperCase()}</span>
      <span style={{ color: C.text }}>{name}</span>
      {role && <span style={{ color: C.textMuted, fontSize: 11 }}>· {ROLE_LABEL_MAP[role] || role}</span>}
    </span>
  );
}

function TagBadge({ tag, onRemove }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 8px', borderRadius: 4,
      background: darkenColor(tag.color),
      color: '#fff',
      border: `1px solid ${darkenColor(tag.color)}`,
      fontSize: 11, fontWeight: 700,
      fontFamily: FONT,
    }}>
      {tag.name}
      {onRemove && (
        <button onClick={onRemove} style={{
          border: 'none', background: 'transparent', cursor: 'pointer',
          color: 'inherit', padding: 0, display: 'flex', alignItems: 'center',
        }}>
          <X size={10} />
        </button>
      )}
    </span>
  );
}

export default function ContactsPage({ user, onNavigate }) {
  const isAdmin = user?.role === 'admin';
  const [numbers, setNumbers] = useState([]);
  const [selectedNumber, setSelectedNumber] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterTagIds, setFilterTagIds] = useState([]);
  // Lead Studio: segment chip, owner/source filters, and sorting.
  const [segment, setSegment] = useState('all');
  const [filterOwner, setFilterOwner] = useState('');   // '' = All, 'none' = Unassigned, else user id
  const [filterSource, setFilterSource] = useState(''); // '' = All, else tag id
  const [sortBy, setSortBy] = useState('name');         // 'name' | 'score' | 'owner'
  const [sortDir, setSortDir] = useState('asc');

  const [categories, setCategories] = useState([]);
  const [tags, setTags] = useState([]);
  const [fieldDefs, setFieldDefs] = useState([]);
  const [users, setUsers] = useState([]); // assignable users (admin only)

  const [detailContact, setDetailContact] = useState(null);
  const [detailName, setDetailName] = useState('');
  const [detailNumber, setDetailNumber] = useState('');
  const [detailTags, setDetailTags] = useState([]);
  const [detailFields, setDetailFields] = useState({});
  const [detailAssignedUserId, setDetailAssignedUserId] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [savingDetail, setSavingDetail] = useState(false);
  const [detailMode, setDetailMode] = useState('view'); // 'view' | 'edit'
  const [deleteModal, setDeleteModal] = useState({ open: false, contact: null });
  const [selectedContacts, setSelectedContacts] = useState(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [broadcastModal, setBroadcastModal] = useState(false);
  const [, setBroadcastMessage] = useState('');
  const [broadcasting, setBroadcasting] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [broadcastFrom, setBroadcastFrom] = useState('');
  const [broadcastTemplateId, setBroadcastTemplateId] = useState('');
  const [broadcastName, setBroadcastName] = useState('');
  const [testNumber, setTestNumber] = useState('');
  const [sendingTest, setSendingTest] = useState(false);
  const [broadcastVariableMapping, setBroadcastVariableMapping] = useState({});
  const [broadcastMessageType, setBroadcastMessageType] = useState('template');
  const [broadcastBody, setBroadcastBody] = useState('');
  const [broadcastUrl, setBroadcastUrl] = useState('');
  const [broadcastMediaLibraryId, setBroadcastMediaLibraryId] = useState('');
  const [broadcastMediaItems, setBroadcastMediaItems] = useState([]);
  const [broadcastCaption, setBroadcastCaption] = useState('');
  const [broadcastMediaLoading, setBroadcastMediaLoading] = useState(false);

  // Import contacts
  const [importModal, setImportModal] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null); // { ok, imported, updated, skipped:[], total }
  const [importError, setImportError] = useState('');

  // Load numbers on mount
  useEffect(() => {
    api.numbers()
      .then(data => {
        setNumbers(data);
        if (data.length > 0) setSelectedNumber(data[0].wa_number);
      })
      .catch(() => setNumbers([]));
  }, []);

  // Load saved contacts when number changes — polled every 5s so that admin
  // reassignments propagate to BDAs without a manual refresh.
  const loadContacts = useCallback((quiet = false) => {
    if (!selectedNumber) return;
    if (!quiet) setLoading(true);
    api.savedContacts(selectedNumber)
      .then(data => setContacts(data.map(c => ({ ...c, tags: c.tags || [] }))))
      .catch(() => setContacts([]))
      .finally(() => { if (!quiet) setLoading(false); });
  }, [selectedNumber]);

  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  // Polling refresh (every 30s).
  useEffect(() => {
    if (!selectedNumber) return;
    const t = setInterval(() => loadContacts(true), 30000);
    return () => clearInterval(t);
  }, [selectedNumber, loadContacts]);

  // Load categories, tags, and team members
  useEffect(() => {
    Promise.all([
      api.categories.list().catch(() => []),
      api.tags.list().catch(() => []),
      api.contactFields.list().catch(() => []),
    ]).then(([cats, tgs, flds]) => {
      setCategories(cats);
      setTags(tgs);
      setFieldDefs(flds);
    });
    // Admins can assign contacts to other users — load the assignable list.
    if (user?.role === 'admin') {
      api.users.list().then(setUsers).catch(() => setUsers([]));
    }
  }, [user]);

  // ── Import contacts ──────────────────────────────────────────────────────
  const ACCEPTED_IMPORT = ['.csv', '.xlsx'];
  const isAcceptedSheet = (file) =>
    !!file && ACCEPTED_IMPORT.some(ext => file.name.toLowerCase().endsWith(ext));

  const openImport = () => { setImportFile(null); setImportResult(null); setImportError(''); setImportModal(true); };
  const closeImport = () => { setImportModal(false); setImportFile(null); setImportResult(null); setImportError(''); };

  const pickImportFile = (file) => {
    if (!file) return;
    if (!isAcceptedSheet(file)) { setImportError('Please choose a .csv or .xlsx file.'); return; }
    setImportError(''); setImportResult(null); setImportFile(file);
  };

  const runImport = async () => {
    if (!importFile || !selectedNumber) return;
    setImporting(true); setImportError('');
    try {
      const res = await api.importContacts(selectedNumber, importFile);
      setImportResult(res);
      loadContacts(true); // refresh the list after import
    } catch (err) {
      setImportError(err.message || 'Import failed. Please try again.');
    } finally {
      setImporting(false);
    }
  };

  // Ctrl+V paste a sheet into the open modal (Zen Chat convention: file inputs support paste)
  useEffect(() => {
    if (!importModal) return;
    const onPaste = (e) => {
      const file = [...(e.clipboardData?.files || [])][0];
      if (file) { e.preventDefault(); pickImportFile(file); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [importModal]);

  const openDetail = async (contact, mode = 'view') => {
    setDetailContact(contact);
    setDetailName(contact.name || '');
    setDetailNumber(contact.contact_number || '');
    setDetailTags(contact.tags || []);
    setDetailFields(contact.custom_fields || {});
    setDetailAssignedUserId(contact.assigned_user_id ?? null);
    setDetailMode(mode);
    setDetailLoading(true);
    try {
      const data = await api.contact(selectedNumber, contact.contact_number);
      setDetailTags(data.tags || []);
      setDetailFields(data.custom_fields || {});
      setDetailAssignedUserId(data.assigned_user_id ?? null);
    } catch (err) {
      console.error('Failed to load contact detail:', err);
    } finally {
      setDetailLoading(false);
    }
  };

  const saveDetail = async () => {
    if (!detailContact) return;
    const oldNumber = detailContact.contact_number;
    const newNumber = String(detailNumber || '').replace(/\D/g, '');
    const numberChanged = !!newNumber && newNumber !== String(oldNumber);
    if (detailNumber && newNumber.length < 7) {
      alert('Enter a valid phone number (digits only, at least 7 digits).');
      return;
    }
    setSavingDetail(true);
    try {
      // If the number changed, migrate the whole conversation + history first
      // (transactional server-side); the contact key changes, so we refetch.
      if (numberChanged) {
        await api.changeContactNumber(selectedNumber, oldNumber, newNumber);
      }
      const effectiveNumber = numberChanged ? newNumber : oldNumber;
      await api.saveContact(
        selectedNumber, effectiveNumber, detailName,
        detailTags, detailFields,
        isAdmin ? (detailAssignedUserId ?? null) : undefined,
      );
      if (numberChanged) {
        await loadContacts(true); // row key moved across tables — refetch
      } else {
        const assignedUser = users.find(u => String(u.id) === String(detailAssignedUserId));
        setContacts(prev => prev.map(c =>
          c.contact_number === oldNumber
            ? {
                ...c, name: detailName || c.name, tags: detailTags, custom_fields: detailFields,
                ...(isAdmin ? {
                  assigned_user_id: detailAssignedUserId ?? null,
                  assigned_user_name: assignedUser?.displayName || null,
                } : {}),
              }
            : c
        ));
      }
      setDetailContact(null);
    } catch (err) {
      alert('Failed to save: ' + err.message);
    } finally {
      setSavingDetail(false);
    }
  };

  const handleDeleteClick = (contact) => {
    setDeleteModal({ open: true, contact });
  };

  const handleDeleteConfirm = async () => {
    const contact = deleteModal.contact;
    if (!contact) return;
    try {
      await api.deleteContact(selectedNumber, contact.contact_number);
      setContacts(prev => prev.filter(c => c.contact_number !== contact.contact_number));
      setDeleteModal({ open: false, contact: null });
    } catch (err) {
      alert('Failed to remove contact: ' + err.message);
    }
  };

  const handleBulkDeleteConfirm = async () => {
    const numbers = [...selectedContacts];
    setBulkDeleteOpen(false);
    if (numbers.length === 0) return;
    const results = await Promise.allSettled(
      numbers.map(n => api.deleteContact(selectedNumber, n))
    );
    const removed = new Set();
    const failures = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') removed.add(numbers[i]);
      else failures.push({ n: numbers[i], err: r.reason });
    });
    if (removed.size > 0) {
      setContacts(prev => prev.filter(c => !removed.has(c.contact_number)));
      setSelectedContacts(prev => {
        const next = new Set(prev);
        removed.forEach(n => next.delete(n));
        return next;
      });
    }
    if (failures.length > 0) {
      alert(`Failed to remove ${failures.length} contact${failures.length === 1 ? '' : 's'}: ${failures[0].err?.message || 'unknown error'}`);
    }
  };

  const toggleTag = (tag) => {
    const exists = detailTags.find(t => t.id === tag.id);
    if (exists) {
      setDetailTags(prev => prev.filter(t => t.id !== tag.id));
    } else {
      // Only one tag per category: remove any other tag from the same category first
      setDetailTags(prev => [
        ...prev.filter(t => t.category_id !== tag.category_id),
        { id: tag.id, name: tag.name, color: tag.color, category_id: tag.category_id }
      ]);
    }
  };

  const sourceCat = useMemo(() => findLeadSourceCategory(categories), [categories]);
  const sourceTags = useMemo(
    () => (sourceCat ? tags.filter(t => t.category_id === sourceCat.id) : []),
    [tags, sourceCat],
  );

  // Everything EXCEPT the segment. The chip counts are computed against this, so
  // a chip says how many of what you're currently looking at are New/Hot/etc —
  // and clicking it can never produce a different number than it promised.
  const baseFiltered = useMemo(() => contacts.filter(c => {
    const matchesSearch = !search ||
      c.contact_number.includes(search) ||
      (c.name && c.name.toLowerCase().includes(search.toLowerCase()));
    const matchesTag = filterTagIds.length === 0 || (c.tags || []).some(t => filterTagIds.includes(t.id));
    const matchesOwner = !filterOwner
      || (filterOwner === 'none' ? !c.assigned_user_id : String(c.assigned_user_id) === String(filterOwner));
    const matchesSource = !filterSource || (c.tags || []).some(t => t.id === filterSource);
    return matchesSearch && matchesTag && matchesOwner && matchesSource;
  }), [contacts, search, filterTagIds, filterOwner, filterSource]);

  const segmentCounts = useMemo(() => {
    const out = {};
    // Same predicate object the filter below uses — not a re-implementation.
    for (const s of SEGMENTS) out[s.key] = baseFiltered.filter(s.match).length;
    return out;
  }, [baseFiltered]);

  const filtered = useMemo(() => {
    const seg = SEGMENTS.find(s => s.key === segment) || SEGMENTS[0];
    const rows = baseFiltered.filter(seg.match);

    const dir = sortDir === 'asc' ? 1 : -1;
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));

    return rows.slice().sort((a, b) => {
      if (sortBy === 'score') {
        const sa = leadScore(a);
        const sb = leadScore(b);
        // Unscored ALWAYS sinks, in both directions. Treating null as 0 would
        // rank a never-scored lead above a genuinely bad one, and flipping the
        // sort would float every unscored lead to the top — the opposite of what
        // "sort by score" is for.
        if (sa === null && sb === null) return byName(a, b);
        if (sa === null) return 1;
        if (sb === null) return -1;
        return (sa - sb) * dir || byName(a, b);
      }
      if (sortBy === 'owner') {
        const oa = a.assigned_user_name || '';
        const ob = b.assigned_user_name || '';
        // Same reasoning: unassigned is absence, not a name that sorts before 'A'.
        if (!oa && !ob) return byName(a, b);
        if (!oa) return 1;
        if (!ob) return -1;
        return oa.localeCompare(ob) * dir || byName(a, b);
      }
      return byName(a, b) * dir;
    });
  }, [baseFiltered, segment, sortBy, sortDir]);

  const toggleSort = (key) => {
    if (sortBy === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(key); setSortDir(key === 'score' ? 'desc' : 'asc'); } // score: best first
  };

  // KPIs for the current WA account, before the segment narrows it — a headline
  // that changed every time you clicked a chip would be useless.
  const kpis = useMemo(() => {
    const total = contacts.length;
    const scored = contacts.map(leadScore).filter(s => s !== null);
    return {
      total,
      newThisWeek: contacts.filter(SEGMENTS.find(s => s.key === 'new').match).length,
      unassigned: contacts.filter(c => !c.assigned_user_id).length,
      avgScore: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null,
      hot: contacts.filter(SEGMENTS.find(s => s.key === 'hot').match).length,
    };
  }, [contacts]);

  const allSelected = filtered.length > 0 && filtered.every(c => selectedContacts.has(c.contact_number));
  const someSelected = filtered.some(c => selectedContacts.has(c.contact_number)) && !allSelected;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedContacts(prev => {
        const next = new Set(prev);
        filtered.forEach(c => next.delete(c.contact_number));
        return next;
      });
    } else {
      setSelectedContacts(prev => {
        const next = new Set(prev);
        filtered.forEach(c => next.add(c.contact_number));
        return next;
      });
    }
  };

  const toggleSelectOne = (contactNumber) => {
    setSelectedContacts(prev => {
      const next = new Set(prev);
      if (next.has(contactNumber)) next.delete(contactNumber);
      else next.add(contactNumber);
      return next;
    });
  };

  const clearSelection = () => setSelectedContacts(new Set());

  /* ── Bulk actions ─────────────────────────────────────────────────────────
     DANGER, and the reason these are hand-written rather than a loop over some
     generic save: POST /contacts/save does `tags = EXCLUDED.tags` with NO
     COALESCE, and api.saveContact defaults `tags = []`. So a bulk action that
     omits tags does not "leave them alone" — it DELETES every tag on the
     contact, and the backend's tag-diff then fires "Tag Removed" automations for
     each one. customFields is whole-object replace too (protected only by an
     `undefined` check), so passing a partial object drops lead_score.

     Every call below therefore passes the row's FULL current tags array, and
     omits customFields entirely so the server preserves it. */

  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState('');
  const [manageTagsOpen, setManageTagsOpen] = useState(false);
  // The category form is state HERE, not inside ManageTagsModal, so it renders
  // as a sibling — nested, its backdrop click would bubble and close the tag
  // manager underneath it.
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false);
  // When set, the new tag is created in this category and immediately applied to
  // the current selection ("create & assign" from the bulk dropdown).
  const [pendingAssignTag, setPendingAssignTag] = useState(null);

  const reloadTagData = useCallback(async () => {
    const [cats, tgs] = await Promise.all([
      api.categories.list().catch(() => categories),
      api.tags.list().catch(() => tags),
    ]);
    setCategories(cats);
    setTags(tgs);
    return tgs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedRows = useMemo(
    () => contacts.filter(c => selectedContacts.has(c.contact_number)),
    [contacts, selectedContacts],
  );

  // Apply a per-row patch, preserving everything the save path would otherwise
  // clobber. `patch(row)` returns { tags?, assignedUserId? }.
  const bulkApply = async (patch, label) => {
    setBulkError('');
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(selectedRows.map(c => {
        const p = patch(c) || {};
        return api.saveContact(
          selectedNumber,
          c.contact_number,
          // '' means "don't touch the name" — the server COALESCEs it.
          '',
          // Full array, always. This is the line that stops a bulk action from
          // wiping the contact's tags.
          p.tags !== undefined ? p.tags : (c.tags || []),
          // customFields omitted => preserved (lead_score survives).
          undefined,
          p.assignedUserId !== undefined ? p.assignedUserId : undefined,
        );
      }));
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length) {
        setBulkError(`${label} failed for ${failed.length} of ${selectedRows.length}: ${failed[0].reason?.message || 'unknown error'}`);
      }
      loadContacts(true);
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkAssignOwner = (userId) =>
    bulkApply(() => ({ assignedUserId: userId === 'none' ? null : parseInt(userId, 10) }), 'Assign owner');

  const bulkAddTag = (tagId) => {
    const tag = tags.find(t => String(t.id) === String(tagId));
    if (!tag) return Promise.resolve();
    const slim = { id: tag.id, name: tag.name, color: tag.color, category_id: tag.category_id };
    return bulkApply(c => ({
      // One tag per category is the invariant everywhere else in this page —
      // adding a tag replaces any existing tag from the SAME category, and
      // leaves every other category untouched.
      tags: [...(c.tags || []).filter(t => t.category_id !== tag.category_id), slim],
    }), 'Add tag');
  };

  const selectedNumberName = numbers.find(n => n.wa_number === selectedNumber)?.display_name || maskPhone(selectedNumber);

  const getTagInfo = (tagRef) => tags.find(t => t.id === tagRef.id) || tagRef;

  // Extract template variables {{1}}, {{2}}, etc.
  const extractVars = (t) => {
    const m = [...(t || '').matchAll(/\{\{(\d+)\}\}/g)];
    return [...new Set(m.map(x => x[1]))].sort((a, b) => +a - +b);
  };

  // Resolve template variables using mapping + first selected contact for live preview
  const resolvePreviewText = (text, mapping, contact) => {
    if (!text || !contact) return text || '';
    return text.replace(/\{\{(\d+)\}\}/g, (_, v) => {
      const field = mapping[v];
      if (!field) return `{{${v}}}`;
      if (field === 'name') return contact.name || `{{${v}}}`;
      if (field === 'contact_number') return maskPhone(contact.contact_number) || `{{${v}}}`;
      if (field.startsWith('custom_fields.')) {
        const id = field.split('.')[1];
        return contact.custom_fields?.[id] || `{{${v}}}`;
      }
      if (field.startsWith('category_tag.')) {
        const catId = field.split('.')[1];
        const tag = contact.tags?.find(t => t.category_id == catId);
        return tag?.name || `{{${v}}}`;
      }
      return `{{${v}}}`;
    });
  };

  const selectedTemplate = templates.find(t => t.id.toString() === broadcastTemplateId);
  // 'image' | 'video' | 'document' when the selected template has a media header
  // (requires a header image at send time), else null.
  const headerMediaType = (() => {
    if (broadcastMessageType !== 'template' || !selectedTemplate) return null;
    const ht = String(selectedTemplate.header_type || '').toUpperCase();
    return ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(ht) ? ht.toLowerCase() : null;
  })();
  const selectedRecipients = contacts.filter(c => selectedContacts.has(c.contact_number));
  const previewTemplate = selectedTemplate ? {
    ...selectedTemplate,
    body: resolvePreviewText(selectedTemplate.body, broadcastVariableMapping, selectedRecipients[0]),
    header_text: selectedTemplate.header_type === 'TEXT' ? resolvePreviewText(selectedTemplate.header_text, broadcastVariableMapping, selectedRecipients[0]) : selectedTemplate.header_text,
  } : null;

  const templateVars = useMemo(() => {
    if (!selectedTemplate) return [];
    const bodyVars = extractVars(selectedTemplate.body);
    const headerVars = selectedTemplate.header_type === 'TEXT' ? extractVars(selectedTemplate.header_text) : [];
    return [...new Set([...headerVars, ...bodyVars])].sort((a, b) => +a - +b);
  }, [selectedTemplate]);

  const isBroadcastFormInvalid = () => {
    if (!broadcastFrom || selectedRecipients.length === 0 || broadcasting) return true;
    if (broadcastMessageType === 'template' && !selectedTemplate) return true;
    if (broadcastMessageType === 'text' && !broadcastBody.trim()) return true;
    if (broadcastMessageType === 'link' && !broadcastUrl.trim()) return true;
    if (['image', 'video', 'audio', 'document'].includes(broadcastMessageType) && !broadcastMediaLibraryId) return true;
    if (headerMediaType && !broadcastMediaLibraryId) return true;
    return false;
  };

  // Load media items for media-type broadcasts OR for a template with a media
  // header (IMAGE/VIDEO/DOCUMENT) — both need a Media Library pick.
  useEffect(() => {
    const mediaTypes = ['image', 'video', 'audio', 'document'];
    let neededType = null;
    if (mediaTypes.includes(broadcastMessageType)) {
      neededType = broadcastMessageType;
    } else if (broadcastMessageType === 'template') {
      const tpl = templates.find(t => t.id.toString() === broadcastTemplateId);
      const ht = String(tpl?.header_type || '').toLowerCase();
      if (['image', 'video', 'document'].includes(ht)) neededType = ht;
    }
    if (!neededType) {
      setBroadcastMediaItems([]);
      setBroadcastMediaLibraryId('');
      return;
    }
    setBroadcastMediaLoading(true);
    api.mediaLibrary.list()
      .then(res => {
        const filtered = (res.media || []).filter(m => m.mediaType === neededType);
        setBroadcastMediaItems(filtered);
      })
      .catch(() => setBroadcastMediaItems([]))
      .finally(() => setBroadcastMediaLoading(false));
  }, [broadcastMessageType, broadcastTemplateId, templates]);

  // Available contact fields for variable mapping
  const contactFieldOptions = useMemo(() => {
    const opts = [
      { value: 'name', label: 'Contact Name' },
      { value: 'contact_number', label: 'Phone Number' },
    ];
    categories.forEach(cat => {
      opts.push({ value: `category_tag.${cat.id}`, label: cat.name });
    });
    return opts;
  }, [categories]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '20px 24px',
        borderBottom: `1px solid ${C.border}`,
        background: C.cardBg,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Users size={22} color={C.text} />
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, margin: 0, letterSpacing: '-.02em', fontFamily: FONT }}>Lead Studio</h1>
              <p style={{ fontSize: 12, color: C.textMuted, margin: '4px 0 0', fontFamily: FONT }}>
                {contacts.length} lead{contacts.length !== 1 ? 's' : ''} on {selectedNumberName}
                {onNavigate && (
                  <>
                    {' · '}
                    {/* Deals already have a kanban. Link to it rather than
                        building a second one that drifts from the first. */}
                    <button
                      type="button"
                      onClick={() => onNavigate('pipelines')}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: C.primary, font: 'inherit', fontWeight: 700 }}
                    >
                      Open the deal pipeline →
                    </button>
                  </>
                )}
              </p>
            </div>
          </div>

          <SearchableSelect
            value={selectedNumber || ''}
            onChange={(val) => setSelectedNumber(val)}
            options={numbers.map(n => ({ value: n.wa_number, label: n.display_name || maskPhone(n.wa_number) }))}
            placeholder="No WhatsApp number"
            searchPlaceholder="Search numbers..."
            disabled={numbers.length === 0}
            style={{ minWidth: 200 }}
            triggerStyle={{ border: `1px solid ${C.border}` }}
          />
        </div>

        {/* KPI strip — the current WA account, before the segment narrows it. */}
        <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
          <Kpi label="Total leads" value={kpis.total} />
          <Kpi label="New this week" value={kpis.newThisWeek} />
          <Kpi label="Unassigned" value={kpis.unassigned} tone={kpis.unassigned > 0 ? 'warn' : undefined} />
          <Kpi label="Avg score" value={kpis.avgScore === null ? '—' : kpis.avgScore}
            hint={kpis.avgScore === null ? 'No leads scored yet' : undefined} />
          <Kpi label={`Hot (${HOT_SCORE}+)`} value={kpis.hot} tone={kpis.hot > 0 ? 'good' : undefined} />
        </div>

        {/* Segment chips. Counts come from the SAME predicate the filter uses,
            so a chip can never promise a number it doesn't then show. */}
        <div style={{ display: 'flex', gap: 6, marginTop: 14, flexWrap: 'wrap' }}>
          {SEGMENTS.map(s => {
            const on = segment === s.key;
            const n = segmentCounts[s.key] ?? 0;
            return (
              <button
                key={s.key}
                type="button"
                aria-pressed={on}
                onClick={() => setSegment(s.key)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 11px', borderRadius: 20, cursor: 'pointer', fontFamily: FONT,
                  fontSize: 12, fontWeight: on ? 700 : 600,
                  border: `1px solid ${on ? C.primary : C.border}`,
                  background: on ? C.primaryLight : 'var(--c-cardBg)',
                  color: on ? C.primary : C.textSecondary,
                }}
              >
                {s.label}
                <span style={{
                  fontSize: 10.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                  padding: '1px 6px', borderRadius: 20,
                  background: on ? 'rgba(255,255,255,.5)' : 'var(--c-surfaceAlt)',
                  color: on ? C.primary : C.textMuted,
                }}>{n}</span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'var(--c-chatPanel)', borderRadius: 8,
            padding: '8px 12px', flex: 1, minWidth: 200, maxWidth: 400,
          }}>
            <Search size={16} color={C.textMuted} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search contacts..."
              style={{
                flex: 1, border: 'none', background: 'transparent',
                fontSize: 14, fontFamily: FONT, outline: 'none', color: C.text,
              }}
            />
          </div>

          <TagMultiSelect
            categories={categories}
            tags={tags}
            selectedIds={filterTagIds}
            onChange={setFilterTagIds}
            minWidth={180}
          />

          {/* Tag management lives HERE now, not in Settings — this is the only
              place anyone applies them. */}
          <button
            onClick={() => setManageTagsOpen(true)}
            title="Create, rename, recolour or remove tags"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 12px', borderRadius: 8,
              border: `1px solid ${C.border}`, background: 'var(--c-cardBg)',
              cursor: 'pointer', fontSize: 12, fontWeight: 600,
              color: C.textSecondary, fontFamily: FONT,
            }}
          >
            <Pencil size={13} /> Manage tags
          </button>

          {/* Owner. Non-admins never get the users list (the route is adminOnly),
              so fall back to the names the rows already carry — otherwise this
              filter would be permanently empty for them. */}
          <SearchableSelect
            value={filterOwner}
            onChange={setFilterOwner}
            // An explicit "All" is required: a placeholder isn't selectable, so
            // without it the filter can be set and never undone.
            options={[
              { value: '', label: 'All owners' },
              { value: 'none', label: 'Unassigned' },
              ...(users.length
                ? users.filter(u => u.isActive !== false).map(u => ({ value: String(u.id), label: u.displayName || u.username }))
                : [...new Map(contacts.filter(c => c.assigned_user_id)
                    .map(c => [String(c.assigned_user_id), c.assigned_user_name || `User ${c.assigned_user_id}`]))]
                    .map(([value, label]) => ({ value, label }))),
            ]}
            placeholder="All owners"
            searchPlaceholder="Search team…"
            style={{ minWidth: 150 }}
            triggerStyle={{ border: `1px solid ${C.border}` }}
          />

          {/* Source — only when the workspace actually has a Lead Source
              category. There is no schema-level source; it's this convention. */}
          {sourceTags.length > 0 && (
            <SearchableSelect
              value={filterSource}
              onChange={setFilterSource}
              options={[
                { value: '', label: 'All sources' },
                ...sourceTags.map(t => ({ value: t.id, label: t.name })),
              ]}
              placeholder="All sources"
              searchPlaceholder="Search sources…"
              style={{ minWidth: 150 }}
              triggerStyle={{ border: `1px solid ${C.border}` }}
            />
          )}

          <button
            onClick={openImport}
            disabled={!selectedNumber}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 8,
              border: `1px solid ${C.border}`, background: C.cardBg,
              cursor: selectedNumber ? 'pointer' : 'not-allowed',
              fontSize: 13, fontWeight: 700, color: C.text, fontFamily: FONT,
              opacity: selectedNumber ? 1 : 0.5,
            }}
            onMouseEnter={e => { if (selectedNumber) e.currentTarget.style.background = 'var(--c-chatPanel)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = C.cardBg; }}
          >
            <Upload size={15} /> Import
          </button>

          <button
            onClick={() => {
              if (selectedContacts.size > 0) {
                setBroadcastModal(true);
                api.templates.list().catch(() => []).then(data => {
                  setTemplates(data.filter(t => t.status === 'APPROVED'));
                });
              }
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '8px 14px', borderRadius: 8,
              border: 'none',
              background: selectedContacts.size > 0 ? C.primary : C.surfaceAlt,
              cursor: selectedContacts.size > 0 ? 'pointer' : 'not-allowed',
              fontSize: 13, fontWeight: 700,
              color: '#fff', fontFamily: FONT,
            }}
          >
            <Send size={14} /> Broadcast
          </button>
          {selectedContacts.size > 0 && (
            <>
              <button
                onClick={() => setBulkDeleteOpen(true)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '8px 14px', borderRadius: 8,
                  border: `1.5px solid ${C.primary}`, background: C.primaryLight,
                  cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  color: C.primary, fontFamily: FONT,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = C.primary; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = C.primaryLight; e.currentTarget.style.color = C.primary; }}
              >
                <Trash2 size={14} /> Delete {selectedContacts.size} selected
              </button>
              <button
                onClick={clearSelection}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '8px 12px', borderRadius: 8,
                  border: `1px solid ${C.border}`, background: 'var(--c-cardBg)',
                  cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  color: C.textSecondary, fontFamily: FONT,
                }}
              >
                <X size={12} /> Clear selection
              </button>
            </>
          )}
          {(search || filterTagIds.length > 0 || filterOwner || filterSource || segment !== 'all') && (
            <button
              onClick={() => { setSearch(''); setFilterTagIds([]); setFilterOwner(''); setFilterSource(''); setSegment('all'); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '8px 12px', borderRadius: 8,
                border: `1px solid ${C.border}`, background: 'var(--c-cardBg)',
                cursor: 'pointer', fontSize: 12, fontWeight: 600,
                color: C.textSecondary, fontFamily: FONT,
              }}
            >
              <X size={12} /> Clear
            </button>
          )}
        </div>

        {/* Bulk actions. Separate row: they only exist with a selection, and
            wedging them into the filter row would make it jump. */}
        {selectedContacts.size > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap',
            padding: '10px 12px', borderRadius: 8,
            background: C.primaryLight, border: `1px solid ${C.primary}33`,
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.primary, fontFamily: FONT }}>
              {selectedContacts.size} selected
            </span>
            {isAdmin && (
              <SearchableSelect
                value=""
                onChange={(v) => { if (v) bulkAssignOwner(v); }}
                options={[
                  { value: 'none', label: 'Unassign' },
                  ...users.filter(u => u.isActive !== false).map(u => ({ value: String(u.id), label: u.displayName || u.username })),
                ]}
                placeholder={bulkBusy ? 'Working…' : 'Assign owner…'}
                searchPlaceholder="Search team…"
                disabled={bulkBusy}
                style={{ minWidth: 170 }}
                triggerStyle={{ border: `1px solid ${C.border}`, background: 'var(--c-cardBg)' }}
              />
            )}
            <SearchableSelect
              value=""
              onChange={(v) => { if (v) bulkAddTag(v); }}
              options={tags.map(t => ({
                value: String(t.id),
                label: t.name,
                sublabel: categories.find(c => c.id === t.category_id)?.name,
              }))}
              placeholder={bulkBusy ? 'Working…' : 'Add tag…'}
              searchPlaceholder="Search tags…"
              disabled={bulkBusy}
              // The tag you need often doesn't exist yet — that's the moment you
              // discover you need it. Sending someone to Settings mid-triage
              // loses both the selection and the thought.
              createLabel="Create a new tag…"
              onCreate={() => { setPendingAssignTag(true); setManageTagsOpen(true); }}
              style={{ minWidth: 170 }}
              triggerStyle={{ border: `1px solid ${C.border}`, background: 'var(--c-cardBg)' }}
            />
            {bulkError && (
              <span role="alert" style={{ fontSize: 12, color: '#DC2626', fontWeight: 600, fontFamily: FONT }}>{bulkError}</span>
            )}
          </div>
        )}
      </div>

      {/* Contact table */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {loading && contacts.length === 0 && (
          <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 13, padding: 40 }}>
            <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 8px' }} />
            Loading contacts...
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 13, padding: 60 }}>
            <User size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
            <div>
              {(search || filterTagIds.length > 0 || filterOwner || filterSource || segment !== 'all')
                ? 'No leads match your filters'
                : 'No saved leads yet'}
            </div>
            {!search && (
              <div style={{ marginTop: 6, fontSize: 12 }}>
                Open a chat and click the edit icon next to a contact name to save it here.
              </div>
            )}
          </div>
        )}

        {filtered.length > 0 && (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--c-hover)' }}>
                  <th style={{ padding: '12px 8px 12px 16px', textAlign: 'center', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}`, width: 40 }}>
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={el => { if (el) el.indeterminate = someSelected; }}
                      onChange={toggleSelectAll}
                      style={{ cursor: 'pointer', width: 16, height: 16 }}
                    />
                  </th>
                  <SortableTh label="Name" col="name" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Phone</th>
                  <SortableTh label="Score" col="score" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} align="right" />
                  <SortableTh label="Owner" col="owner" sortBy={sortBy} sortDir={sortDir} onSort={toggleSort} />
                  {categories.map(cat => (
                    <th key={cat.id} style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>{cat.name}</th>
                  ))}
                  <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, color: C.textSecondary, borderBottom: `1px solid ${C.border}` }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const isSelected = selectedContacts.has(c.contact_number);
                  return (
                    <tr key={c.contact_number} style={{ background: isSelected ? 'var(--c-primaryLight)' : 'var(--c-cardBg)', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}
                      onClick={() => openDetail(c, 'view')}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(0,0,0,.06)'; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'var(--c-cardBg)'; }}
                    >
                      <td style={{ padding: '12px 8px 12px 16px', textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelectOne(c.contact_number)}
                          style={{ cursor: 'pointer', width: 16, height: 16 }}
                        />
                      </td>
                      <td style={{ padding: '12px 16px', fontWeight: 600, color: C.text }}>{c.name}</td>
                      <td style={{ padding: '12px 16px', color: C.textSecondary }}><MaskedNumber number={c.contact_number} prefix="+" /></td>
                      <td style={{ padding: '12px 16px', textAlign: 'right' }}><ScoreCell score={leadScore(c)} /></td>
                      <td style={{ padding: '12px 16px', color: C.textSecondary }}>
                        {c.assigned_user_name
                          ? <OwnerChip name={c.assigned_user_name} role={c.assigned_user_role} />
                          : <span style={{ color: C.textMuted, fontSize: 12 }}>Unassigned</span>}
                      </td>
                      {categories.map(cat => {
                        const tag = (c.tags || []).find(t => t.category_id === cat.id);
                        const info = tag ? getTagInfo(tag) : null;
                        return (
                          <td key={cat.id} style={{ padding: '12px 16px' }}>
                            {info ? <TagBadge tag={info} /> : <span style={{ color: C.textMuted, fontSize: 12 }}>—</span>}
                          </td>
                        );
                      })}
                      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                        <button onClick={(e) => { e.stopPropagation(); openDetail(c, 'edit'); }} style={{
                          border: 'none', background: 'transparent', cursor: 'pointer',
                          color: C.primary, fontSize: 12, fontWeight: 600, marginRight: 12,
                        }}>
                          <Pencil size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />Edit
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteClick(c); }} style={{
                          border: 'none', background: 'transparent', cursor: 'pointer',
                          color: C.primary, fontSize: 12, fontWeight: 600,
                        }}>Delete</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Delete Confirm Modal */}
      <DeleteConfirmModal
        open={deleteModal.open}
        title="Remove Contact"
        message={deleteModal.contact ? `Are you sure you want to remove "${deleteModal.contact.name}" from saved contacts?` : ''}
        confirmText="Remove"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModal({ open: false, contact: null })}
      />

      {/* Bulk Delete Confirm Modal */}
      <DeleteConfirmModal
        open={bulkDeleteOpen}
        title={`Remove ${selectedContacts.size} contact${selectedContacts.size === 1 ? '' : 's'}`}
        message={`Are you sure you want to remove ${selectedContacts.size} contact${selectedContacts.size === 1 ? '' : 's'} from saved contacts? This cannot be undone.`}
        confirmText="Remove"
        onConfirm={handleBulkDeleteConfirm}
        onCancel={() => setBulkDeleteOpen(false)}
      />

      {/* Manage tags + New category are SIBLINGS, never nested. Rendering the
          category form inside the tag modal would let its backdrop click bubble
          up and close the tag modal underneath it. */}
      {manageTagsOpen && (
        <ManageTagsModal
          categories={categories}
          tags={tags}
          onClose={() => { setManageTagsOpen(false); setPendingAssignTag(null); }}
          onChanged={async () => {
            const fresh = await reloadTagData();
            // "Create & assign": the tag was created from the bulk dropdown, so
            // apply it to the selection immediately rather than making them
            // re-open the dropdown and find it.
            if (pendingAssignTag && selectedContacts.size > 0) {
              const newest = fresh
                .slice()
                .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];
              if (newest) await bulkAddTag(newest.id);
              setPendingAssignTag(null);
              setManageTagsOpen(false);
            }
          }}
          onCreateCategory={() => setCreateCategoryOpen(true)}
        />
      )}
      {createCategoryOpen && (
        <CreateCategoryModal
          onClose={() => setCreateCategoryOpen(false)}
          onCreated={async () => {
            // Refetch categories so the tag form's picker has the new one. The
            // tag form does NOT reset on this — it keys its reset on the tag
            // being edited, so a half-typed name survives.
            await reloadTagData();
            setCreateCategoryOpen(false);
          }}
        />
      )}

      {/* Import Contacts Modal */}
      {importModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 }}
          onClick={closeImport}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: C.cardBg, borderRadius: 14, boxShadow: C.shadowLg, width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto', fontFamily: FONT }}
          >
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 22px', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Upload size={18} color={C.primary} />
                <h2 style={{ fontSize: 17, fontWeight: 700, color: C.text, margin: 0 }}>Import Contacts</h2>
              </div>
              <button onClick={closeImport} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted, display: 'flex', padding: 4 }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ padding: '20px 22px' }}>
              <p style={{ fontSize: 13, color: C.textSecondary, margin: '0 0 18px', lineHeight: 1.5 }}>
                Add contacts to <strong style={{ color: C.text }}>{selectedNumberName}</strong>. Upload a sheet with
                {' '}<strong style={{ color: C.text }}>Name</strong> and <strong style={{ color: C.text }}>Phone Number</strong> columns
                (include the country code, e.g. <span style={{ fontFamily: "'Geist Mono', monospace" }}>919876543210</span>).
              </p>

              {importResult ? (
                /* ---- Result summary ---- */
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                    <CheckCircle2 size={20} color={C.green} />
                    <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Import complete</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginBottom: importResult.skipped?.length ? 16 : 0 }}>
                    {[
                      { label: 'Added', value: importResult.imported, color: C.green },
                      { label: 'Updated', value: importResult.updated, color: C.purple },
                      { label: 'Skipped', value: importResult.skipped?.length || 0, color: importResult.skipped?.length ? C.primary : C.textMuted },
                    ].map(s => (
                      <div key={s.label} style={{ flex: 1, border: `1px solid ${C.border}`, borderRadius: 10, padding: '12px 14px', textAlign: 'center' }}>
                        <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: "'Geist Mono', monospace" }}>{s.value}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2 }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                  {importResult.skipped?.length > 0 && (
                    <div style={{ background: 'rgba(245,158,11,.14)', border: '1px solid rgba(245,158,11,.24)', borderRadius: 10, padding: '10px 14px', maxHeight: 160, overflowY: 'auto' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: '#D97706', marginBottom: 6 }}>
                        <AlertTriangle size={14} /> Skipped rows
                      </div>
                      {importResult.skipped.map((s, i) => (
                        <div key={i} style={{ fontSize: 12, color: '#D97706', padding: '2px 0' }}>
                          Row {s.row}: {s.reason}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                /* ---- Upload step ---- */
                <>
                  <a
                    href={api.importContactsTemplateUrl()}
                    download
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 8,
                      padding: '9px 14px', borderRadius: 8, marginBottom: 16,
                      border: `1px solid ${C.border}`, background: 'var(--c-chatPanel)',
                      cursor: 'pointer', fontSize: 13, fontWeight: 600, color: C.text,
                      textDecoration: 'none',
                    }}
                  >
                    <Download size={15} color={C.primary} /> Download sample sheet
                  </a>

                  <label
                    onDragOver={e => { e.preventDefault(); }}
                    onDrop={e => { e.preventDefault(); pickImportFile([...(e.dataTransfer?.files || [])][0]); }}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
                      border: `2px dashed ${importFile ? C.green : C.border}`, borderRadius: 12,
                      padding: '28px 20px', cursor: 'pointer', textAlign: 'center',
                      background: importFile ? 'rgba(15,110,86,0.05)' : 'transparent',
                    }}
                  >
                    <input
                      type="file"
                      accept=".csv,.xlsx"
                      style={{ display: 'none' }}
                      onChange={e => pickImportFile(e.target.files?.[0])}
                    />
                    {importFile ? (
                      <>
                        <FileSpreadsheet size={26} color={C.green} />
                        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{importFile.name}</span>
                        <span style={{ fontSize: 12, color: C.textMuted }}>Click to choose a different file</span>
                      </>
                    ) : (
                      <>
                        <FileSpreadsheet size={26} color={C.textMuted} />
                        <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Click to upload, drag a file here, or paste (Ctrl+V)</span>
                        <span style={{ fontSize: 12, color: C.textMuted }}>Accepts .csv and .xlsx</span>
                      </>
                    )}
                  </label>
                </>
              )}

              {importError && (
                <div style={{ marginTop: 14, background: 'rgba(239,68,68,.14)', color: '#DC2626', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
                  {importError}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 22px', borderTop: `1px solid ${C.border}` }}>
              {importResult ? (
                <button
                  onClick={closeImport}
                  style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: C.primary, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: FONT }}
                >
                  Done
                </button>
              ) : (
                <>
                  <button
                    onClick={closeImport}
                    style={{ padding: '9px 18px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.cardBg, color: C.textSecondary, cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: FONT }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={runImport}
                    disabled={!importFile || importing}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '9px 20px', borderRadius: 8, border: 'none',
                      background: (!importFile || importing) ? C.surfaceAlt : C.primary, color: '#fff',
                      cursor: (!importFile || importing) ? 'not-allowed' : 'pointer',
                      fontSize: 13, fontWeight: 700, fontFamily: FONT,
                    }}
                  >
                    {importing ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Importing…</> : <>Import contacts</>}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Broadcast Modal */}
      {broadcastModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 200, fontFamily: FONT,
        }}>
          <div style={{
            background: C.cardBg, borderRadius: 14,
            width: 900, maxHeight: '90vh',
            boxShadow: C.shadowLg, overflowY: 'auto',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Modal Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>
                <Send size={18} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 8, color: C.primary }} />
                Broadcast Message
              </div>
              <button onClick={() => { setBroadcastModal(false); setBroadcastMessage(''); setBroadcastTemplateId(''); setBroadcastName(''); setTestNumber(''); setBroadcastMessageType('template'); setBroadcastBody(''); setBroadcastUrl(''); setBroadcastMediaLibraryId(''); setBroadcastMediaItems([]); setBroadcastCaption(''); setBroadcastMediaLoading(false); }} style={{
                border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
              }}><X size={20} /></button>
            </div>

            {/* Two-column body */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 420px', gap: 24, padding: '20px 24px' }}>
              {/* LEFT — Form */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

                {/* Broadcast Name */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Broadcast Name</div>
                  <input
                    type="text"
                    value={broadcastName}
                    onChange={e => setBroadcastName(e.target.value)}
                    placeholder="e.g. April Fee Reminder"
                    style={{
                      width: '100%', padding: '10px 12px', borderRadius: 8,
                      border: `1.5px solid ${C.border}`, fontSize: 13,
                      fontFamily: FONT, color: C.text, outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                {/* From */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>From (Team Member Number)</div>
                  <SearchableSelect
                    value={broadcastFrom}
                    onChange={(val) => setBroadcastFrom(val)}
                    options={numbers.map(n => ({ value: n.wa_number, label: n.display_name || maskPhone(n.wa_number) }))}
                    placeholder="Select team member number..."
                    searchPlaceholder="Search numbers..."
                  />
                </div>

                {/* To */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>To ({selectedRecipients.length} selected)</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 100, overflowY: 'auto', padding: '10px 12px', background: 'var(--c-hover)', borderRadius: 8, border: `1.5px solid ${C.border}` }}>
                    {selectedRecipients.map(c => (
                      <span key={c.contact_number} style={{ fontSize: 11, color: C.textSecondary, background: 'var(--c-cardBg)', padding: '3px 10px', borderRadius: 99, border: `1px solid ${C.border}`, fontFamily: FONT, fontWeight: 500 }}>
                        {c.name} (<MaskedNumber number={c.contact_number} prefix="+" />)
                      </span>
                    ))}
                  </div>
                </div>

                {/* Message Type */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Message Type</div>
                  <SearchableSelect
                    value={broadcastMessageType}
                    onChange={(val) => setBroadcastMessageType(val)}
                    options={[
                      { value: 'template', label: 'Template Message' },
                      { value: 'text', label: 'Text Message' },
                      { value: 'link', label: 'Link Message' },
                      { value: 'image', label: 'Image Message' },
                      { value: 'video', label: 'Video Message' },
                      { value: 'audio', label: 'Audio Message' },
                      { value: 'document', label: 'Document Message' },
                    ]}
                  />
                </div>

                {/* Template Fields */}
                {broadcastMessageType === 'template' && (
                  <>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Message Template</div>
                      <SearchableSelect
                        value={broadcastTemplateId}
                        onChange={(val) => { setBroadcastTemplateId(val); setBroadcastVariableMapping({}); setBroadcastMediaLibraryId(''); }}
                        options={templates.map(t => ({ value: String(t.id), label: `${t.name} (${t.category})`, sublabel: t.language || '' }))}
                        placeholder="Select a template..."
                        searchPlaceholder="Search templates..."
                        emptyText="No templates found"
                        createLabel="Create new template"
                        onCreate={() => onNavigate?.('template-builder', 'new')}
                      />
                      {templates.length === 0 && (
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>No approved templates available. Create and approve a template first.</div>
                      )}
                    </div>

                    {/* Header media — required for IMAGE/VIDEO/DOCUMENT header templates */}
                    {headerMediaType && (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                          Header {headerMediaType} <span style={{ color: C.primary }}>*</span>
                        </div>
                        <SearchableSelect
                          value={broadcastMediaLibraryId}
                          onChange={(val) => setBroadcastMediaLibraryId(val)}
                          disabled={broadcastMediaLoading}
                          options={broadcastMediaItems.map(m => ({ value: String(m.id), label: m.name || m.originalName || `Media #${m.id}` }))}
                          placeholder={broadcastMediaLoading ? 'Loading...' : `— Select ${headerMediaType} —`}
                          searchPlaceholder="Search media..."
                        />
                        {broadcastMediaItems.length === 0 && !broadcastMediaLoading ? (
                          <div style={{ fontSize: 11, color: '#D97706', marginTop: 4, fontFamily: FONT }}>
                            This template has a {headerMediaType} header — upload a {headerMediaType} to the Media Library first.
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>
                            This template has a {headerMediaType} header — pick the {headerMediaType} to send in the header.
                          </div>
                        )}
                        {broadcastMediaLibraryId && headerMediaType === 'image' && (
                          <img
                            src={api.mediaLibrary.downloadUrl(Number(broadcastMediaLibraryId))}
                            alt=""
                            style={{ marginTop: 8, width: '100%', maxHeight: 140, objectFit: 'cover', borderRadius: 8, border: `1px solid ${C.border}`, display: 'block' }}
                          />
                        )}
                      </div>
                    )}

                    {templateVars.length > 0 && (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Variable Mapping</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {templateVars.map(v => (
                            <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: C.text, fontFamily: "'Geist Mono', monospace", background: 'var(--c-hover)', padding: '4px 8px', borderRadius: 4, whiteSpace: 'nowrap' }}>{'{{' + v + '}}'}</span>
                              <span style={{ fontSize: 12, color: C.textMuted }}>→</span>
                              <SearchableSelect
                                value={broadcastVariableMapping[v] || ''}
                                onChange={(val) => setBroadcastVariableMapping(prev => ({ ...prev, [v]: val }))}
                                options={contactFieldOptions}
                                placeholder="Select contact field..."
                                searchPlaceholder="Search fields..."
                                style={{ flex: 1 }}
                                triggerStyle={{ padding: '8px 28px 8px 10px', borderRadius: 6, fontSize: 12 }}
                              />
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6, fontFamily: FONT }}>
                          Map each template variable to a contact field. Values will be pulled per recipient when sending.
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Text Fields */}
                {broadcastMessageType === 'text' && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Message Text</div>
                    <textarea
                      value={broadcastBody}
                      onChange={e => setBroadcastBody(e.target.value)}
                      placeholder="Type your message here..."
                      rows={4}
                      style={{
                        width: '100%', padding: '10px 12px', borderRadius: 8,
                        border: `1.5px solid ${C.border}`, fontSize: 13,
                        fontFamily: FONT, color: C.text, outline: 'none',
                        boxSizing: 'border-box', resize: 'vertical',
                      }}
                    />
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>
                      Use {'{{name}}'} and {'{{contact_number}}'} for dynamic values per recipient.
                    </div>
                  </div>
                )}

                {/* Link Fields */}
                {broadcastMessageType === 'link' && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Link URL</div>
                    <input
                      type="text"
                      value={broadcastUrl}
                      onChange={e => setBroadcastUrl(e.target.value)}
                      placeholder="https://example.com"
                      style={{
                        width: '100%', padding: '10px 12px', borderRadius: 8,
                        border: `1.5px solid ${C.border}`, fontSize: 13,
                        fontFamily: FONT, color: C.text, outline: 'none',
                        boxSizing: 'border-box',
                      }}
                    />
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>
                      The link will be sent as a text message with preview enabled.
                    </div>
                  </div>
                )}

                {/* Media Fields */}
                {['image', 'video', 'audio', 'document'].includes(broadcastMessageType) && (
                  <>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Select from Media Library</div>
                      <SearchableSelect
                        value={broadcastMediaLibraryId}
                        onChange={(val) => setBroadcastMediaLibraryId(val)}
                        disabled={broadcastMediaLoading}
                        options={broadcastMediaItems.map(m => ({ value: String(m.id), label: m.name || m.originalName || `Media #${m.id}` }))}
                        placeholder={broadcastMediaLoading ? 'Loading...' : `— Select ${broadcastMessageType} —`}
                        searchPlaceholder="Search media..."
                      />
                      {broadcastMediaItems.length === 0 && !broadcastMediaLoading && (
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, fontFamily: FONT }}>
                          No {broadcastMessageType}s in the Media Library. Upload one from the Media tab first.
                        </div>
                      )}
                    </div>

                    {broadcastMediaLibraryId && (
                      <div style={{ borderRadius: 10, overflow: 'hidden', border: `1px solid ${C.border}`, background: 'var(--c-hover)' }}>
                        {broadcastMessageType === 'image' ? (
                          <img
                            src={api.mediaLibrary.downloadUrl(Number(broadcastMediaLibraryId))}
                            alt=""
                            style={{ width: '100%', height: 140, objectFit: 'cover', display: 'block' }}
                          />
                        ) : broadcastMessageType === 'video' ? (
                          <div style={{ position: 'relative', width: '100%', height: 140 }}>
                            <video
                              src={api.mediaLibrary.downloadUrl(Number(broadcastMediaLibraryId))}
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              preload="metadata"
                              muted
                            />
                            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.25)' }}>
                              <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <Play size={16} color="#0A0A0A" fill="#0A0A0A" />
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
                            <div style={{ width: 40, height: 40, borderRadius: 8, background: 'rgba(34,197,94,.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#16A34A' }}>
                              {broadcastMessageType === 'audio' ? <Music size={20} /> : <FileText size={20} />}
                            </div>
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 600, color: C.text, fontFamily: FONT }}>
                                {broadcastMediaItems.find(m => String(m.id) === String(broadcastMediaLibraryId))?.name || 'Media'}
                              </div>
                              <div style={{ fontSize: 11, color: C.textMuted, fontFamily: FONT, textTransform: 'capitalize' }}>
                                {broadcastMessageType}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {broadcastMessageType !== 'audio' && (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Caption (optional)</div>
                        <input
                          type="text"
                          value={broadcastCaption}
                          onChange={e => setBroadcastCaption(e.target.value)}
                          placeholder="Optional caption..."
                          style={{
                            width: '100%', padding: '10px 12px', borderRadius: 8,
                            border: `1.5px solid ${C.border}`, fontSize: 13,
                            fontFamily: FONT, color: C.text, outline: 'none',
                            boxSizing: 'border-box',
                          }}
                        />
                      </div>
                    )}
                  </>
                )}

                {/* Test Number */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Test Number</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {/* Single-owner system: enter the test recipient number directly */}
                    <input
                      type="tel"
                      value={testNumber}
                      onChange={e => setTestNumber(e.target.value)}
                      placeholder="Enter test number (e.g. 919342245724)"
                      style={{
                        flex: 1, padding: '10px 12px', borderRadius: 8,
                        border: `1.5px solid ${C.border}`, fontSize: 13,
                        fontFamily: FONT, color: C.text, background: 'var(--c-cardBg)',
                        outline: 'none', boxSizing: 'border-box',
                      }}
                    />
                    <button
                      onClick={async () => {
                        if (!testNumber.trim() || !broadcastFrom || selectedRecipients.length === 0) return;
                        if (broadcastMessageType === 'template' && !selectedTemplate) return;
                        if (broadcastMessageType === 'text' && !broadcastBody.trim()) return;
                        if (broadcastMessageType === 'link' && !broadcastUrl.trim()) return;
                        if (['image', 'video', 'audio', 'document'].includes(broadcastMessageType) && !broadcastMediaLibraryId) return;
                        if (headerMediaType && !broadcastMediaLibraryId) return;
                        setSendingTest(true);
                        try {
                          const payload = {
                            from_number: broadcastFrom,
                            recipient_numbers: selectedRecipients.map(r => ({ contact_number: r.contact_number, name: r.name })),
                            status: 'DRAFT',
                            test_number: testNumber.trim(),
                            name: broadcastName.trim() || undefined,
                            message_type: broadcastMessageType,
                          };
                          if (broadcastMessageType === 'template') {
                            payload.template_id = selectedTemplate.id;
                            payload.variable_mapping = broadcastVariableMapping;
                          } else if (broadcastMessageType === 'text') {
                            payload.body = broadcastBody;
                          } else if (broadcastMessageType === 'link') {
                            payload.url = broadcastUrl;
                          } else if (['image', 'video', 'audio', 'document'].includes(broadcastMessageType)) {
                            payload.media_library_id = Number(broadcastMediaLibraryId);
                            payload.caption = broadcastCaption || undefined;
                          }
                          const broadcast = await api.broadcasts.create(payload);
                          await api.broadcasts.test(broadcast.id, testNumber.trim());
                          alert(`Test message sent to ${testNumber}`);
                        } catch (err) {
                          alert('Test failed: ' + err.message);
                        } finally {
                          setSendingTest(false);
                        }
                      }}
                      disabled={!testNumber.trim() || !broadcastFrom || selectedRecipients.length === 0 || sendingTest || (broadcastMessageType === 'template' && !selectedTemplate) || (broadcastMessageType === 'text' && !broadcastBody.trim()) || (broadcastMessageType === 'link' && !broadcastUrl.trim()) || (['image','video','audio','document'].includes(broadcastMessageType) && !broadcastMediaLibraryId) || (headerMediaType && !broadcastMediaLibraryId)}
                      style={{
                        padding: '10px 16px', borderRadius: 8, border: 'none',
                        background: C.primary, color: '#fff',
                        cursor: (!testNumber.trim() || !selectedTemplate || !broadcastFrom || sendingTest) ? 'not-allowed' : 'pointer',
                        fontSize: 12, fontWeight: 700, fontFamily: FONT,
                        opacity: (!testNumber.trim() || !selectedTemplate || !broadcastFrom || sendingTest) ? 0.5 : 1,
                        display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
                      }}
                    >
                      {sendingTest ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />}
                      Send Test
                    </button>
                  </div>
                </div>

                {/* Spacer */}
                <div style={{ flex: 1 }} />

                {/* Bottom Buttons */}
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                  <button onClick={() => { setBroadcastModal(false); setBroadcastMessage(''); setBroadcastTemplateId(''); setBroadcastName(''); setTestNumber(''); setBroadcastVariableMapping({}); setBroadcastMessageType('template'); setBroadcastBody(''); setBroadcastUrl(''); setBroadcastMediaLibraryId(''); setBroadcastMediaItems([]); setBroadcastCaption(''); setBroadcastMediaLoading(false); }} style={{
                    padding: '10px 18px', borderRadius: 8, border: `1px solid ${C.border}`,
                    background: 'transparent', cursor: 'pointer', fontSize: 13,
                    fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
                  }}>Cancel</button>
                  <button
                    onClick={async () => {
                      if (isBroadcastFormInvalid()) return;
                      setBroadcasting(true);
                      try {
                        const payload = {
                          from_number: broadcastFrom,
                          recipient_numbers: selectedRecipients.map(r => ({ contact_number: r.contact_number, name: r.name })),
                          status: 'DRAFT',
                          test_number: testNumber || undefined,
                          name: broadcastName.trim() || undefined,
                          message_type: broadcastMessageType,
                        };
                        if (broadcastMessageType === 'template') {
                          payload.template_id = selectedTemplate.id;
                          payload.variable_mapping = broadcastVariableMapping;
                          if (headerMediaType && broadcastMediaLibraryId) payload.media_library_id = Number(broadcastMediaLibraryId);
                        } else if (broadcastMessageType === 'text') {
                          payload.body = broadcastBody;
                        } else if (broadcastMessageType === 'link') {
                          payload.url = broadcastUrl;
                        } else if (['image', 'video', 'audio', 'document'].includes(broadcastMessageType)) {
                          payload.media_library_id = Number(broadcastMediaLibraryId);
                          payload.caption = broadcastCaption || undefined;
                        }
                        await api.broadcasts.create(payload);
                        alert('Broadcast saved as draft');
                        setBroadcastModal(false);
                        setBroadcastTemplateId('');
                        setBroadcastName('');
                        setTestNumber('');
                        setBroadcastFrom('');
                        setBroadcastMessageType('template');
                        setBroadcastBody('');
                        setBroadcastUrl('');
                        setBroadcastMediaLibraryId('');
                        setBroadcastMediaItems([]);
                        setBroadcastCaption('');
                      } catch (err) {
                        alert('Save failed: ' + err.message);
                      } finally {
                        setBroadcasting(false);
                      }
                    }}
                    disabled={isBroadcastFormInvalid()}
                    style={{
                      padding: '10px 18px', borderRadius: 8, border: `1.5px solid ${C.primary}`,
                      background: 'var(--c-cardBg)', color: C.primary, cursor: isBroadcastFormInvalid() ? 'not-allowed' : 'pointer',
                      fontSize: 13, fontWeight: 700, fontFamily: FONT,
                      opacity: isBroadcastFormInvalid() ? 0.5 : 1,
                    }}
                  >
                    Save as Draft
                  </button>
                  <button
                    onClick={async () => {
                      if (isBroadcastFormInvalid()) return;
                      setBroadcasting(true);
                      try {
                        const payload = {
                          from_number: broadcastFrom,
                          recipient_numbers: selectedRecipients.map(r => ({ contact_number: r.contact_number, name: r.name })),
                          status: 'SENT',
                          test_number: testNumber || undefined,
                          name: broadcastName.trim() || undefined,
                          message_type: broadcastMessageType,
                        };
                        if (broadcastMessageType === 'template') {
                          payload.template_id = selectedTemplate.id;
                          payload.variable_mapping = broadcastVariableMapping;
                          if (headerMediaType && broadcastMediaLibraryId) payload.media_library_id = Number(broadcastMediaLibraryId);
                        } else if (broadcastMessageType === 'text') {
                          payload.body = broadcastBody;
                        } else if (broadcastMessageType === 'link') {
                          payload.url = broadcastUrl;
                        } else if (['image', 'video', 'audio', 'document'].includes(broadcastMessageType)) {
                          payload.media_library_id = Number(broadcastMediaLibraryId);
                          payload.caption = broadcastCaption || undefined;
                        }
                        const broadcast = await api.broadcasts.create(payload);
                        await api.broadcasts.send(broadcast.id);
                        alert(`Broadcast sent to ${selectedRecipients.length} contact(s) from ${broadcastFrom}!`);
                        setBroadcastModal(false);
                        setBroadcastTemplateId('');
                        setBroadcastName('');
                        setTestNumber('');
                        setBroadcastFrom('');
                        setBroadcastMessageType('template');
                        setBroadcastBody('');
                        setBroadcastUrl('');
                        setBroadcastMediaLibraryId('');
                        setBroadcastMediaItems([]);
                        setBroadcastCaption('');
                        clearSelection();
                      } catch (err) {
                        alert('Broadcast failed: ' + err.message);
                      } finally {
                        setBroadcasting(false);
                      }
                    }}
                    disabled={isBroadcastFormInvalid()}
                    style={{
                      padding: '10px 18px', borderRadius: 8, border: 'none',
                      background: isBroadcastFormInvalid() ? C.surfaceAlt : C.primary,
                      color: '#fff', cursor: isBroadcastFormInvalid() ? 'not-allowed' : 'pointer',
                      fontSize: 13, fontWeight: 700, fontFamily: FONT,
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    {broadcasting && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
                    Broadcast
                  </button>
                </div>
              </div>

              {/* RIGHT — Preview */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em', color: '#888', fontFamily: FONT }}>Live Preview</div>
                {broadcastMessageType === 'template' ? (
                  <WhatsAppPreview template={previewTemplate} minHeight={280} emptyText="Select a template&#10;to preview" />
                ) : (
                  <BroadcastMessagePreview
                    messageType={broadcastMessageType}
                    body={broadcastBody}
                    url={broadcastUrl}
                    mediaLibraryId={broadcastMediaLibraryId}
                    caption={broadcastCaption}
                    mediaItems={broadcastMediaItems}
                    minHeight={280}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Contact Detail / Edit Modal */}
      {detailContact && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 200, fontFamily: FONT,
        }}>
          <div style={{
            background: C.cardBg, borderRadius: 14,
            padding: '24px 24px 20px', width: 480, maxHeight: '85vh',
            boxShadow: C.shadowLg, overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>
                {detailMode === 'edit' ? 'Edit Contact' : 'Contact Details'}
              </div>
              <button onClick={() => setDetailContact(null)} style={{
                border: 'none', background: 'transparent', cursor: 'pointer', color: C.textMuted,
              }}><X size={18} /></button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, marginBottom: detailMode === 'edit' ? 6 : 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Name</div>
              {detailMode === 'edit' ? (
                <input
                  value={detailName}
                  onChange={e => setDetailName(e.target.value)}
                  placeholder="Contact name"
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 8,
                    border: `1px solid ${C.border}`, fontSize: 14, fontFamily: FONT,
                    color: C.text, outline: 'none', background: 'var(--c-cardBg)', boxSizing: 'border-box',
                  }}
                />
              ) : (
                <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{detailContact.name || '—'}</div>
              )}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, marginBottom: detailMode === 'edit' ? 6 : 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Phone</div>
              {detailMode === 'edit' ? (
                <>
                  <input
                    value={detailNumber}
                    onChange={e => setDetailNumber(e.target.value)}
                    placeholder="e.g. 919342245724"
                    inputMode="numeric"
                    style={{
                      width: '100%', padding: '8px 12px', borderRadius: 8,
                      border: `1px solid ${C.border}`, fontSize: 14, fontFamily: MONO,
                      color: C.text, outline: 'none', background: 'var(--c-cardBg)', boxSizing: 'border-box',
                    }}
                  />
                  {String(detailNumber || '').replace(/\D/g, '') !== String(detailContact.contact_number) && (
                    <div style={{ fontSize: 11, color: '#D97706', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <AlertTriangle size={11} /> Changing the number moves the entire conversation &amp; history to it.
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 14, color: C.textSecondary, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Phone size={12} /> <MaskedNumber number={detailContact.contact_number} prefix="+" />
                </div>
              )}
            </div>

            {/* Assigned to (chat owner) — admins can (re)assign to a sales user */}
            {isAdmin && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, marginBottom: detailMode === 'edit' ? 6 : 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Assigned to</div>
                {detailMode === 'edit' ? (
                  <SearchableSelect
                    value={detailAssignedUserId ?? ''}
                    onChange={(val) => setDetailAssignedUserId(val || null)}
                    options={[{ value: '', label: 'Unassigned' }, ...users.filter(u => u.isActive !== false).map(u => ({ value: String(u.id), label: `${u.displayName || u.username} (${ROLE_LABEL_MAP[u.role] || u.role})` }))]}
                    placeholder="Unassigned"
                    searchPlaceholder="Search team..."
                    triggerStyle={{ padding: '9px 12px', border: `1px solid ${C.border}` }}
                  />
                ) : (
                  <div style={{ fontSize: 14, color: C.text }}>
                    {(() => {
                      const u = users.find(x => String(x.id) === String(detailAssignedUserId));
                      return u ? (u.displayName || u.username) : (detailContact.assigned_user_name || 'Unassigned');
                    })()}
                  </div>
                )}
              </div>
            )}

            <div style={{ marginBottom: detailMode === 'edit' ? 8 : 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Assigned Tags</div>
              {detailTags.length === 0 ? (
                <div style={{ color: C.textMuted, fontSize: 12 }}>No tags assigned</div>
              ) : (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {detailTags.map(t => {
                    const info = getTagInfo(t);
                    return <TagBadge key={t.id} tag={info} onRemove={detailMode === 'edit' ? () => toggleTag(info) : null} />;
                  })}
                </div>
              )}
            </div>

            {/* Tag picker — only in edit mode */}
            {detailMode === 'edit' && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.textSecondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Assign Tags</div>
                {detailLoading ? (
                  <div style={{ color: C.textMuted, fontSize: 12 }}>Loading tags…</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {categories.map(cat => {
                      const catTags = tags.filter(t => t.category_id === cat.id);
                      if (catTags.length === 0) return null;
                      const selectedInCat = detailTags.find(t => t.category_id === cat.id);
                      return (
                        <div key={cat.id}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>{cat.name}</div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {catTags.map(tag => {
                              const isSelected = detailTags.some(t => t.id === tag.id);
                              return (
                                <button
                                  key={tag.id}
                                  onClick={() => toggleTag(tag)}
                                  style={{
                                    padding: '4px 10px', borderRadius: 4,
                                    border: `1.5px solid ${isSelected ? tag.color : C.border}`,
                                    background: isSelected ? tag.color : 'var(--c-cardBg)',
                                    color: isSelected ? '#fff' : C.textSecondary,
                                    cursor: 'pointer', fontFamily: FONT, fontSize: 12,
                                    fontWeight: 600,
                                  }}
                                >
                                  {tag.name}
                                </button>
                              );
                            })}
                          </div>
                          {selectedInCat && (
                            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                              Selected: <strong style={{ color: selectedInCat.color }}>{selectedInCat.name}</strong>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Custom fields */}
            {detailMode === 'edit'
              ? <CustomFieldEditor fields={fieldDefs} values={detailFields} onChange={setDetailFields} />
              : <CustomFieldView fields={fieldDefs} values={detailFields} />}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {detailMode === 'view' ? (
                <>
                  <button onClick={() => setDetailContact(null)} style={{
                    padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`,
                    background: 'transparent', cursor: 'pointer', fontSize: 13,
                    fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
                  }}>Close</button>
                  <button onClick={() => setDetailMode('edit')} style={{
                    padding: '8px 16px', borderRadius: 8, border: 'none',
                    background: C.primary, color: '#fff', cursor: 'pointer',
                    fontSize: 13, fontWeight: 600, fontFamily: FONT,
                  }}>
                    <Pencil size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />Edit
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => setDetailContact(null)} style={{
                    padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`,
                    background: 'transparent', cursor: 'pointer', fontSize: 13,
                    fontWeight: 600, color: C.textSecondary, fontFamily: FONT,
                  }}>Cancel</button>
                  <button onClick={saveDetail} disabled={savingDetail} style={{
                    padding: '8px 16px', borderRadius: 8, border: 'none',
                    background: C.primary, color: '#fff', cursor: savingDetail ? 'not-allowed' : 'pointer',
                    fontSize: 13, fontWeight: 600, fontFamily: FONT,
                    opacity: savingDetail ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    {savingDetail && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />}
                    Save
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
