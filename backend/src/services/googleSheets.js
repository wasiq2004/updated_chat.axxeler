// Google Sheets service wrapper.
//
// Every call resolves a fresh access token via googleAuth.getAccessToken(),
// which silently refreshes the cached token if it's about to expire. Tools
// hand us a credentialId; we never see plain tokens.
//
// Ops: `read`, `append`, `update`, `upsert`, `getRows`, `deleteRow`,
// `clearSheet`. Plus picker helpers (`listSpreadsheets`, `listSheetTabs`) used
// by the UI when the operator is configuring which sheet to touch.
//
// The operator maps COLUMN NAMES, never A1 ranges — this service owns all
// row/range arithmetic. A misconfigured flow therefore can't scribble on the
// wrong cells; the worst it can do is address a column that doesn't exist,
// which is reported rather than written.
//
// IDEMPOTENCY, and why it decides what may be retried:
//   Google can apply a write and still fail the response. Retrying `append`
//   duplicates the row; retrying `deleteRow` removes a SECOND row. Only
//   read / update-by-key / clear are safe to retry — see IDEMPOTENT_OPS.

const { google } = require('googleapis');
const { getAccessToken } = require('./googleAuth');

// ── helpers for the `upsert` op ────────────────────────────────────────────
function colLetter(idx) {
  let s = ''; let n = Number(idx);
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
function normCell(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function digitsOnly(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
// Match a cell against a key — exact (case-insensitive) OR digits-only (so
// "+91 94877 22330" matches "919487722330" for phone-number keys).
function keyMatch(cell, key) {
  if (normCell(cell) !== '' && normCell(cell) === normCell(key)) return true;
  const dc = digitsOnly(cell); const dk = digitsOnly(key);
  return dc !== '' && dc === dk;
}
// Parse the start row/col index from a returned A1 range like
// "'Enquiry tracker'!A1:G23" → { row: 1, col: 0 } (1-based row, 0-based col).
function parseStart(rangeA1) {
  const m = String(rangeA1 || '').match(/!\$?([A-Z]+)\$?(\d+)/);
  if (!m) return { row: 1, col: 0 };
  let col = 0; for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: parseInt(m[2], 10), col: col - 1 };
}

async function authedSheets(credentialId) {
  const token = await getAccessToken(credentialId);
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: token });
  return google.sheets({ version: 'v4', auth: oauth2 });
}

async function authedDrive(credentialId) {
  const token = await getAccessToken(credentialId);
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: token });
  return google.drive({ version: 'v3', auth: oauth2 });
}

/**
 * Pick-list for the UI. Lists the user's Google Sheets (mimeType-filtered,
 * not their whole Drive), newest first. Requires the `drive.readonly` scope —
 * `drive.file` only surfaces app-created/opened files, so pre-existing sheets
 * would never show up in the picker.
 */
async function listSpreadsheets(credentialId, { pageSize = 50, query = '' } = {}) {
  const drive = await authedDrive(credentialId);
  const safeQuery = query.replace(/'/g, "\\'").slice(0, 100);
  const q = [
    "mimeType='application/vnd.google-apps.spreadsheet'",
    'trashed=false',
    safeQuery ? `name contains '${safeQuery}'` : null,
  ].filter(Boolean).join(' and ');
  const { data } = await drive.files.list({
    q,
    pageSize,
    fields: 'files(id,name,modifiedTime)',
    orderBy: 'modifiedTime desc',
  });
  return data.files || [];
}

/**
 * List the tab (sheet) names inside one spreadsheet, so the operator can pick
 * which tab the agent reads/writes.
 */
async function listSheetTabs(credentialId, spreadsheetId) {
  const sheets = await authedSheets(credentialId);
  const { data } = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',
  });
  return (data.sheets || []).map(s => ({
    sheetId: s.properties.sheetId,
    title: s.properties.title,
    rowCount: s.properties.gridProperties?.rowCount,
    columnCount: s.properties.gridProperties?.columnCount,
  }));
}

/**
 * Tool op: read a range from the configured sheet.
 *  args.range — optional A1 (defaults to the whole tab if omitted)
 *  args.max_rows — soft cap so the LLM doesn't get a wall of data
 */
async function read({ credentialId, spreadsheetId, sheetName, args = {} }) {
  const sheets = await authedSheets(credentialId);
  const range = args.range
    ? (args.range.includes('!') ? args.range : `'${sheetName}'!${args.range}`)
    : `'${sheetName}'`;
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = data.values || [];
  const maxRows = Math.max(1, Math.min(500, parseInt(args.max_rows || 100, 10)));
  return {
    range: data.range,
    rowCount: rows.length,
    truncated: rows.length > maxRows,
    rows: rows.slice(0, maxRows),
  };
}

/**
 * Tool op: append a row. `args.values` is an array of cell values (left-to-right).
 * USER_ENTERED so dates/numbers/formulas behave like a human typed them.
 */
async function append({ credentialId, spreadsheetId, sheetName, args = {} }) {
  if (!Array.isArray(args.values)) {
    throw new Error('append requires args.values (array)');
  }
  const sheets = await authedSheets(credentialId);
  // Deterministic placement: read the tab, find the LAST non-empty row, and
  // write the new row right after it via values.update at an explicit range.
  // We do NOT use values.append — its "table detection" lands on the styled
  // header row when the tab is a Sheets "Table" (title banner in row 1 +
  // dark-blue header in row 2), which made rows overwrite the header band.
  // This way the agent never chooses a row number; the code computes it.
  const { data: read } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:Z2000`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = read.values || [];
  const start = parseStart(read.range); // 1-based first row of the read window
  let lastNonEmpty = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] || []).some(c => String(c == null ? '' : c).trim() !== '')) lastNonEmpty = i;
  }
  const targetRow = start.row + lastNonEmpty + 1; // first empty row after content
  const endCol = colLetter(Math.max(0, args.values.length - 1));
  const { data } = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!A${targetRow}:${endCol}${targetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [args.values] },
  });
  return {
    action: 'appended',
    row: targetRow,
    updatedRange: data.updatedRange,
    updatedRows: data.updatedRows,
    updatedCells: data.updatedCells,
  };
}

/**
 * Tool op: write `args.values` into a specific range (`args.range`).
 * Used to update an existing row the LLM identified via `read`.
 */
async function update({ credentialId, spreadsheetId, sheetName, args = {} }) {
  if (!args.range) throw new Error('update requires args.range');
  if (!Array.isArray(args.values)) throw new Error('update requires args.values (array)');
  const sheets = await authedSheets(credentialId);
  // Single row: wrap in an outer array; matrix: pass through.
  const values = Array.isArray(args.values[0]) ? args.values : [args.values];
  const range = args.range.includes('!') ? args.range : `'${sheetName}'!${args.range}`;
  const { data } = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
  return {
    updatedRange: data.updatedRange,
    updatedRows: data.updatedRows,
    updatedCells: data.updatedCells,
  };
}

/**
 * Tool op: find-or-create a row by a key column, writing only named columns.
 * The engine handles header discovery, row numbers and the column offset so the
 * LLM never deals with A1 ranges — it just gives
 * { key_column, key_value, fields:{ "Header Name": value } }. The reliable way
 * to keep a single evolving row per contact (vs. raw append/update).
 */
async function upsert({ credentialId, spreadsheetId, sheetName, args = {} }) {
  const keyColumn = args.key_column;
  const keyValue = args.key_value;
  const fields = args.fields;
  if (!keyColumn) throw new Error('upsert requires args.key_column (a header name, e.g. "Phone Number")');
  if (keyValue == null || keyValue === '') throw new Error('upsert requires args.key_value');
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('upsert requires args.fields as an object of { "Column Header": value, ... }');
  }
  const sheets = await authedSheets(credentialId);
  const { data: readData } = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `'${sheetName}'!A1:Z2000`, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = readData.values || [];
  const start = parseStart(readData.range);

  // 1. Locate the header row (first row that contains the key column name).
  let hIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] || []).some(c => normCell(c) === normCell(keyColumn))) { hIdx = i; break; }
  }
  if (hIdx === -1) throw new Error(`Could not find a header row containing "${keyColumn}" in tab "${sheetName}". Check the column name.`);
  const header = rows[hIdx];
  const colOf = (name) => header.findIndex(c => normCell(c) === normCell(name));
  const keyCol = colOf(keyColumn);

  // 2. Resolve each field name → its column index (skip unknown columns).
  const writes = []; const skippedUnknownColumns = [];
  for (const [name, value] of Object.entries(fields)) {
    const c = colOf(name);
    if (c === -1) skippedUnknownColumns.push(name); else writes.push({ col: c, value });
  }
  if (writes.length === 0) throw new Error(`None of the given field names matched a column header in "${sheetName}". Headers are: ${header.filter(Boolean).join(', ')}`);

  // 3. Find the existing data row whose key column matches key_value.
  let dIdx = -1;
  for (let i = hIdx + 1; i < rows.length; i++) {
    if (keyMatch((rows[i] || [])[keyCol], keyValue)) { dIdx = i; break; }
  }

  const writeSpan = async (absRow, minC, maxC, span) => {
    const { data } = await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${sheetName}'!${colLetter(minC)}${absRow}:${colLetter(maxC)}${absRow}`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [span] },
    });
    return data;
  };

  if (dIdx !== -1) {
    const absRow = start.row + dIdx;
    const cols = writes.map(w => w.col);
    const minC = Math.min(...cols); const maxC = Math.max(...cols);
    const existing = rows[dIdx] || [];
    const span = [];
    for (let c = minC; c <= maxC; c++) {
      const w = writes.find(x => x.col === c);
      span.push(w ? w.value : (existing[c] != null ? existing[c] : ''));
    }
    await writeSpan(absRow, minC, maxC, span);
    return { action: 'updated', row: absRow, key: { column: keyColumn, value: keyValue }, wrote: writes.map(w => header[w.col]), skippedUnknownColumns };
  }

  // 4. No match.
  //
  // create_if_missing defaults TRUE so the agent-tool behaviour is unchanged.
  // The automation's "Update row" node passes false when the operator didn't ask
  // for a create — silently inventing a row is how you get duplicate customers
  // from a typo'd key.
  if (args.create_if_missing === false) {
    return { action: 'not_found', key: { column: keyColumn, value: keyValue } };
  }
  let lastNonEmpty = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] || []).some(c => String(c == null ? '' : c).trim() !== '')) lastNonEmpty = i;
  }
  const targetRow = start.row + lastNonEmpty + 1;
  const maxC = Math.max(keyCol, ...writes.map(w => w.col));
  const rowArr = new Array(maxC + 1).fill('');
  rowArr[keyCol] = keyValue;
  for (const w of writes) rowArr[w.col] = w.value;
  await writeSpan(targetRow, 0, maxC, rowArr);
  return { action: 'appended', row: targetRow, key: { column: keyColumn, value: keyValue }, wrote: writes.map(w => header[w.col]), skippedUnknownColumns };
}

/* ── Ops added for the automation builder's Sheets nodes ──────────────────── */

// Read window. Both `append` and `upsert` already hardcode A1:Z2000; these ops
// reuse the same ceiling so every op agrees on what "the sheet" is. Beyond it,
// row arithmetic would silently mis-target, so the ops report truncation rather
// than quietly working on a prefix.
const MAX_COL = 'Z';
const MAX_ROW = 2000;

// Find the header row + column indexes. Deliberately NOT "row 1": these sheets
// often have a styled title banner above the real header (the same thing that
// makes values.append land on the header band).
function locateHeader(rows, requiredColumn) {
  let hIdx = -1;
  if (requiredColumn) {
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i] || []).some(c => normCell(c) === normCell(requiredColumn))) { hIdx = i; break; }
    }
  } else {
    // No anchor column given: the first row with any non-empty cell.
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i] || []).some(c => String(c == null ? '' : c).trim() !== '')) { hIdx = i; break; }
    }
  }
  return hIdx;
}

/**
 * Op: addRow — append a row from COLUMN-NAME → value mappings.
 *
 * The operator names columns; this resolves them to positions against the real
 * header, so re-ordering the sheet's columns can't shift their data into the
 * wrong ones. Unknown column names are reported, not written blindly.
 *
 * Not idempotent (it appends) — never auto-retried.
 */
async function addRow({ credentialId, spreadsheetId, sheetName, args = {} }) {
  const fields = args.fields || {};
  const names = Object.keys(fields);
  if (names.length === 0) throw new Error('addRow needs at least one column mapped.');

  const sheets = await authedSheets(credentialId);
  const { data: readData } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:${MAX_COL}${MAX_ROW}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = readData.values || [];
  const start = parseStart(readData.range);
  // Anchor on any mapped column so a styled title banner above the real header
  // doesn't get mistaken for it.
  let hIdx = -1;
  for (const n of names) {
    hIdx = locateHeader(rows, n);
    if (hIdx !== -1) break;
  }
  if (hIdx === -1) {
    throw new Error(`Could not find a header row containing any of: ${names.join(', ')} — check the column names in tab "${sheetName}".`);
  }
  const header = rows[hIdx];
  const skippedUnknownColumns = [];
  const cells = [];
  for (const [name, value] of Object.entries(fields)) {
    const col = header.findIndex(c => normCell(c) === normCell(name));
    if (col === -1) { skippedUnknownColumns.push(name); continue; }
    cells[col] = value;
  }
  if (cells.length === 0) {
    throw new Error(`None of the mapped columns exist in tab "${sheetName}": ${skippedUnknownColumns.join(', ')}`);
  }

  let lastNonEmpty = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] || []).some(c => String(c == null ? '' : c).trim() !== '')) lastNonEmpty = i;
  }
  const targetRow = start.row + lastNonEmpty + 1;
  const maxC = cells.length - 1;
  const rowArr = [];
  for (let c = 0; c <= maxC; c++) rowArr.push(cells[c] !== undefined ? cells[c] : '');

  const { data } = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!A${targetRow}:${colLetter(maxC)}${targetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowArr] },
  });
  return {
    action: 'appended',
    row: targetRow,
    updatedRange: data.updatedRange,
    wrote: Object.keys(fields).filter(n => !skippedUnknownColumns.includes(n)),
    skippedUnknownColumns,
  };
}

/**
 * Op: getRows — rows matching a column value, as objects keyed by header name.
 * Branches Found / Not found in the builder.
 *   args.key_column, args.key_value  — optional; omit to return every data row
 *   args.max_rows
 */
async function getRows({ credentialId, spreadsheetId, sheetName, args = {} }) {
  const sheets = await authedSheets(credentialId);
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:${MAX_COL}${MAX_ROW}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = data.values || [];
  const start = parseStart(data.range);
  const hIdx = locateHeader(rows, args.key_column || null);
  if (hIdx === -1) {
    throw new Error(args.key_column
      ? `Could not find a header row containing "${args.key_column}" in tab "${sheetName}".`
      : `Tab "${sheetName}" looks empty — no header row found.`);
  }
  const header = rows[hIdx];
  const asObject = (r, i) => {
    const o = {};
    header.forEach((h, ci) => { if (String(h || '').trim()) o[String(h).trim()] = r[ci] ?? ''; });
    // The sheet row number, so a later update/delete addresses the right line.
    o.__row = start.row + hIdx + 1 + i;
    return o;
  };
  let data_rows = rows.slice(hIdx + 1).map(asObject);
  if (args.key_column) {
    const keyCol = header.findIndex(c => normCell(c) === normCell(args.key_column));
    data_rows = rows.slice(hIdx + 1)
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => keyMatch(r[keyCol], args.key_value))
      .map(({ r, i }) => asObject(r, i));
  }
  const maxRows = Math.max(1, Math.min(500, parseInt(args.max_rows || 100, 10)));
  return {
    headers: header.map(h => String(h ?? '')),
    found: data_rows.length > 0,
    rowCount: data_rows.length,
    truncated: data_rows.length > maxRows,
    rows: data_rows.slice(0, maxRows),
  };
}

/**
 * Op: deleteRow — remove the first row whose key column matches.
 *
 * NOT idempotent: a retry deletes a DIFFERENT row (everything shifts up), so
 * this must never be retried automatically. See IDEMPOTENT_OPS.
 */
async function deleteRow({ credentialId, spreadsheetId, sheetName, args = {} }) {
  if (!args.key_column || args.key_value === undefined) {
    throw new Error('deleteRow requires args.key_column and args.key_value');
  }
  const sheets = await authedSheets(credentialId);
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:${MAX_COL}${MAX_ROW}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = data.values || [];
  const start = parseStart(data.range);
  const hIdx = locateHeader(rows, args.key_column);
  if (hIdx === -1) throw new Error(`Could not find a header row containing "${args.key_column}" in tab "${sheetName}".`);
  const header = rows[hIdx];
  const keyCol = header.findIndex(c => normCell(c) === normCell(args.key_column));
  let target = -1;
  for (let i = hIdx + 1; i < rows.length; i++) {
    if (keyMatch((rows[i] || [])[keyCol], args.key_value)) { target = i; break; }
  }
  if (target === -1) return { action: 'not_found', key: { column: args.key_column, value: args.key_value } };

  // batchUpdate.deleteDimension needs the numeric sheetId, not the tab name —
  // the values API is name-addressed, the structural API is id-addressed.
  const tabs = await listSheetTabs(credentialId, spreadsheetId);
  const tab = tabs.find(t => t.title === sheetName);
  if (!tab) throw new Error(`Tab "${sheetName}" not found in this spreadsheet.`);
  const sheetRowIndex = start.row + target - 1; // 0-based for the API

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: tab.sheetId, dimension: 'ROWS', startIndex: sheetRowIndex, endIndex: sheetRowIndex + 1 },
        },
      }],
    },
  });
  return { action: 'deleted', row: sheetRowIndex + 1, key: { column: args.key_column, value: args.key_value } };
}

/**
 * Op: clearSheet — wipe the data rows, keeping the header.
 * Idempotent: clearing twice leaves the same sheet.
 */
async function clearSheet({ credentialId, spreadsheetId, sheetName, args = {} }) {
  const sheets = await authedSheets(credentialId);
  const { data: read } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:${MAX_COL}${MAX_ROW}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = read.values || [];
  const start = parseStart(read.range);
  const hIdx = args.keep_header === false ? -1 : locateHeader(rows, null);
  // Keep everything up to and including the header; clear from the next row.
  const firstDataRow = start.row + hIdx + 1;
  if (rows.length === 0) return { action: 'cleared', rowsCleared: 0 };
  const lastRow = start.row + rows.length - 1;
  if (lastRow < firstDataRow) return { action: 'cleared', rowsCleared: 0 };
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${sheetName}'!A${firstDataRow}:${MAX_COL}${lastRow}`,
  });
  return { action: 'cleared', rowsCleared: lastRow - firstDataRow + 1, keptHeader: hIdx !== -1 };
}

// Which ops may be retried after a failure.
//
// Google can APPLY a write and still fail the response (a timeout on the way
// back). So a retry is only safe where doing it twice equals doing it once:
//   append    -> duplicates the row
//   deleteRow -> deletes a second, different row (rows shift up)
// Both are excluded. update/upsert address a row BY KEY, so a repeat rewrites
// the same cells with the same values.
const IDEMPOTENT_OPS = new Set(['read', 'getRows', 'update', 'upsert', 'clearSheet']);

/**
 * Dispatcher used by the agent engine. Looks at the tool's `config.ops` to
 * gate which operations the LLM is allowed to call — defense in depth, since
 * the LLM only ever sees the ops we expose to it in the tool schema anyway.
 */
async function executeOp({ op, toolConfig, args }) {
  const allowed = Array.isArray(toolConfig.ops) ? toolConfig.ops : [];
  if (!allowed.includes(op)) {
    throw new Error(`Operation '${op}' is not enabled for this Sheets tool. Enabled: ${allowed.join(', ') || 'none'}`);
  }
  const ctx = {
    credentialId: toolConfig.google_account_id,
    spreadsheetId: toolConfig.spreadsheet_id,
    sheetName: toolConfig.sheet_name,
    args,
  };
  return runOp(op, ctx);
}

const OPS = { read, append, update, upsert, addRow, getRows, deleteRow, clearSheet };

function isRetryable(err) {
  // Rate limit / transient server errors only. A 400 (bad column name) or a 403
  // (no access) will fail identically forever — retrying just delays the error
  // and burns quota.
  const status = err?.code || err?.response?.status;
  return status === 429 || (status >= 500 && status < 600);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Run one op, retrying ONLY when that is safe and useful.
 *
 * Two independent conditions, both required:
 *   1. the op is idempotent (IDEMPOTENT_OPS) — a retry must not double-write;
 *   2. the error is transient (429/5xx) — a retry must have a chance.
 *
 * Backoff is exponential with jitter. Three instant retries against a rate limit
 * are just three failures: the whole point of hitting 429 is that you are going
 * too fast.
 */
async function runOp(op, ctx, { retries = 2 } = {}) {
  const fn = OPS[op];
  if (!fn) throw new Error(`Unknown Sheets op: ${op}`);
  const canRetry = IDEMPOTENT_OPS.has(op);
  let lastErr;
  for (let attempt = 0; attempt <= (canRetry ? retries : 0); attempt++) {
    try {
      return await fn(ctx);
    } catch (err) {
      lastErr = err;
      if (!canRetry || !isRetryable(err) || attempt === retries) break;
      // 500ms, 1s (+ up to 250ms jitter so parallel flows don't retry in lockstep)
      await sleep(500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
    }
  }
  throw lastErr;
}

module.exports = {
  listSpreadsheets,
  listSheetTabs,
  read,
  append,
  update,
  upsert,
  addRow,
  getRows,
  deleteRow,
  clearSheet,
  executeOp,
  runOp,
  IDEMPOTENT_OPS,
  // Exported for the polling trigger, which needs the same row/header
  // arithmetic. Duplicating it would let the trigger and the ops disagree about
  // where the header is.
  _internals: { colLetter, normCell, digitsOnly, keyMatch, parseStart, locateHeader, MAX_COL, MAX_ROW },
};
