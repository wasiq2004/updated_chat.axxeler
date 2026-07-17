// Google Sheets polling trigger — the diff logic, which is the whole feature.
//
// Sheets has no row-change webhook, so "what changed" is a snapshot diff. Every
// case here is a stated trap, and each one fails in the worst possible way: not
// by erroring, but by re-firing an automation forever, or by blasting hundreds
// of executions at once.
//
// snapshotRows/diffSnapshot are pure, so no database and no Google are needed.

const { test } = require('node:test');
const assert = require('node:assert');
const { snapshotRows, diffSnapshot } = require('../src/services/sheetTrigger');

// A realistic tab: a styled title banner ABOVE the header (this is what makes
// Google's values.append land on the header band), then the header, then data.
const ROWS = [
  ['Enquiry tracker', '', ''],
  ['Phone', 'Name', 'Status'],
  ['919876543210', 'Priya', 'New'],
  ['919111222333', 'Amir', 'Contacted'],
];

test('finds the header even when a title banner sits above it', () => {
  const { header, identities } = snapshotRows(ROWS, 'Phone');
  assert.deepEqual(header, ['Phone', 'Name', 'Status']);
  assert.equal(Object.keys(identities).length, 2);
  assert.equal(identities['919876543210'].row.Name, 'Priya');
});

test('identity comes from the key column, NOT the row number', () => {
  const a = snapshotRows(ROWS, 'Phone');
  // Same rows, re-sorted — exactly what a user clicking a column header does.
  const resorted = [ROWS[0], ROWS[1], ROWS[3], ROWS[2]];
  const b = snapshotRows(resorted, 'Phone');
  // Against row numbers every row would look changed and the whole tab would
  // re-fire on the next poll.
  assert.deepEqual(Object.keys(a.identities).sort(), Object.keys(b.identities).sort());
  const { added, updated } = diffSnapshot(
    Object.fromEntries(Object.entries(a.identities).map(([k, v]) => [k, v.hash])),
    b.identities,
  );
  assert.deepEqual(added, []);
  assert.deepEqual(updated, []);
});

test('duplicate key values get DISTINCT identities', () => {
  const rows = [
    ['Phone', 'Name'],
    ['919876543210', 'Priya'],
    ['919876543210', 'Priya (second enquiry)'],
    ['919876543210', 'Priya (third)'],
  ];
  const { identities } = snapshotRows(rows, 'Phone');
  // A sheet is not a database — the same number legitimately appears twice.
  // Collapsing them drops one from the snapshot, so the next poll sees it as new
  // and fires it AGAIN, every tick, forever.
  assert.equal(Object.keys(identities).length, 3, 'all three rows must be represented');
  assert.deepEqual(Object.keys(identities).sort(), ['919876543210', '919876543210#2', '919876543210#3']);
  assert.equal(identities['919876543210#2'].row.Name, 'Priya (second enquiry)');
});

test('a duplicate-key sheet is STABLE across polls — the forever-refire case', () => {
  const rows = [['Phone', 'Name'], ['999', 'A'], ['999', 'B']];
  const first = snapshotRows(rows, 'Phone');
  const stored = Object.fromEntries(Object.entries(first.identities).map(([k, v]) => [k, v.hash]));
  const second = snapshotRows(rows, 'Phone');
  const { added, updated } = diffSnapshot(stored, second.identities);
  assert.deepEqual(added, [], 'an unchanged duplicate-key sheet must fire nothing on the next poll');
  assert.deepEqual(updated, []);
});

test('KNOWN LIMITATION: re-sorting DUPLICATE-key rows fires spuriously', () => {
  // Pinning a deliberate trade-off, not asserting desired behaviour.
  //
  // The #N suffix follows sheet order, so swapping two rows that share a key
  // swaps their identities and both look changed. With a UNIQUE key column
  // (the case the UI asks for) re-sorting is fully stable — proved above.
  //
  // This is irreducible at this layer: when the key doesn't identify the row,
  // "A was edited" and "A deleted, C added" are the same observation. The
  // alternative — content-hash identities — makes every edit look like an add,
  // which is worse for the common case.
  const rows = [['Phone', 'Name'], ['999', 'A'], ['999', 'B']];
  const stored = Object.fromEntries(Object.entries(snapshotRows(rows, 'Phone').identities).map(([k, v]) => [k, v.hash]));
  const resorted = [['Phone', 'Name'], ['999', 'B'], ['999', 'A']];
  const { added, updated } = diffSnapshot(stored, snapshotRows(resorted, 'Phone').identities);
  assert.equal(added.length + updated.length, 2, 'if this changes, the trade-off changed — update the docs and the UI hint');
});

test('the QUIET failure this design avoids: a lost row whose edits never fire', () => {
  // What a naive `identity = keyValue` snapshot does. Keeping this as a test so
  // the reason for the #N suffix survives any future "simplification".
  const naive = (rows) => Object.fromEntries(rows.slice(1).map(r => [r[0], JSON.stringify(r)]));
  const rows = [['Phone', 'Name'], ['999', 'A'], ['999', 'B']];
  const edited = [['Phone', 'Name'], ['999', 'A-EDITED'], ['999', 'B']];

  const naiveStored = naive(rows);
  const naiveFires = Object.entries(naive(edited)).filter(([k, v]) => naiveStored[k] !== v).length;
  assert.equal(naiveFires, 0, 'naive identity loses row A entirely — its edit is invisible forever');

  const ourStored = Object.fromEntries(Object.entries(snapshotRows(rows, 'Phone').identities).map(([k, v]) => [k, v.hash]));
  const d = diffSnapshot(ourStored, snapshotRows(edited, 'Phone').identities);
  assert.equal(d.added.length + d.updated.length, 1, 'ours sees the edit');
});

test('detects a genuinely added row', () => {
  const before = snapshotRows(ROWS, 'Phone');
  const stored = Object.fromEntries(Object.entries(before.identities).map(([k, v]) => [k, v.hash]));
  const after = snapshotRows([...ROWS, ['919000111222', 'Zara', 'New']], 'Phone');
  const { added, updated } = diffSnapshot(stored, after.identities);
  assert.equal(added.length, 1);
  assert.equal(added[0].identity, '919000111222');
  assert.equal(added[0].row.Name, 'Zara');
  assert.equal(updated.length, 0);
});

test('detects a genuinely updated row, and only that row', () => {
  const before = snapshotRows(ROWS, 'Phone');
  const stored = Object.fromEntries(Object.entries(before.identities).map(([k, v]) => [k, v.hash]));
  const edited = ROWS.map(r => (r[0] === '919111222333' ? ['919111222333', 'Amir', 'Qualified'] : r));
  const after = snapshotRows(edited, 'Phone');
  const { added, updated } = diffSnapshot(stored, after.identities);
  assert.equal(added.length, 0);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].identity, '919111222333');
  assert.equal(updated[0].row.Status, 'Qualified');
});

test('an unchanged sheet produces no events at all', () => {
  const before = snapshotRows(ROWS, 'Phone');
  const stored = Object.fromEntries(Object.entries(before.identities).map(([k, v]) => [k, v.hash]));
  const { added, updated } = diffSnapshot(stored, snapshotRows(ROWS, 'Phone').identities);
  assert.deepEqual(added, []);
  assert.deepEqual(updated, []);
});

test('a removed row is not an event', () => {
  const before = snapshotRows(ROWS, 'Phone');
  const stored = Object.fromEntries(Object.entries(before.identities).map(([k, v]) => [k, v.hash]));
  const after = snapshotRows(ROWS.slice(0, 3), 'Phone'); // Amir deleted
  const { added, updated } = diffSnapshot(stored, after.identities);
  // Firing a flow for a row that no longer exists would be nonsense.
  assert.deepEqual(added, []);
  assert.deepEqual(updated, []);
});

test('skips blank rows and rows with no key', () => {
  const rows = [
    ['Phone', 'Name'],
    ['919876543210', 'Priya'],
    ['', 'No phone'],       // no key => no stable identity across a re-sort
    ['', ''],               // blank spacer row
  ];
  const { identities } = snapshotRows(rows, 'Phone');
  assert.equal(Object.keys(identities).length, 1);
});

test('a missing key column is a clear error, not a silent zero-row poll', () => {
  assert.throws(
    () => snapshotRows(ROWS, 'Email'),
    (err) => err.code === 'NO_HEADER' && /Email/.test(err.message),
  );
});

test('the key match is forgiving about phone formatting', () => {
  const rows = [['Phone', 'Name'], ['+91 98765 43210', 'Priya']];
  const { identities } = snapshotRows(rows, 'Phone');
  // Identity keeps the raw cell (that's what the operator sees), but the hash is
  // of the row, so reformatting the cell IS a change — which is correct: the
  // sheet genuinely changed.
  assert.ok(Object.keys(identities)[0].includes('98765'));
});

test('editing a non-key column changes the hash', () => {
  const a = snapshotRows([['Phone', 'Name'], ['999', 'A']], 'Phone');
  const b = snapshotRows([['Phone', 'Name'], ['999', 'B']], 'Phone');
  assert.notEqual(a.identities['999'].hash, b.identities['999'].hash);
});

test('the row object is keyed by header name, ignoring empty header cells', () => {
  const rows = [['Phone', '', 'Status'], ['999', 'ignored', 'New']];
  const { identities } = snapshotRows(rows, 'Phone');
  assert.deepEqual(Object.keys(identities['999'].row).sort(), ['Phone', 'Status']);
});
