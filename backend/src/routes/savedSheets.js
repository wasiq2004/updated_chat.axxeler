// Saved sheet library — named spreadsheet+tab shortcuts.
//
// Connect a sheet once in Settings, name it, then pick it BY NAME anywhere a
// sheet is needed instead of walking account → spreadsheet → tab every time.
//
// Permissions, deliberately split:
//   READ   — anyone who can build flows. A picker they can't read is useless,
//            and the entries name sheets, they don't grant access to them.
//   WRITE  — admin. Adding an entry points the whole workspace at a sheet.

const { Router } = require('express');
const pool = require('../db');
const { adminOnly, scopeClause, orgScope } = require('../middleware/access');
const googleSheets = require('../services/googleSheets');

const router = Router();

function shape(r) {
  return {
    id: r.id,
    name: r.name,
    googleAccountId: r.google_account_id,
    googleAccountLabel: r.account_label || null,
    spreadsheetId: r.spreadsheet_id,
    spreadsheetName: r.spreadsheet_name || null,
    sheetName: r.sheet_name,
    // Surfaced so a picker can warn before someone builds on a dead credential.
    accountHealth: r.health_status || null,
    createdAt: r.created_at,
  };
}

// GET /saved-sheets — the picker. Any authenticated user.
router.get('/saved-sheets', async (req, res) => {
  try {
    const params = [];
    const where = scopeClause(req, 's', params, { leading: 'WHERE ' }) + orgScope(req, 's', params);
    const { rows } = await pool.query(
      `SELECT s.*, o.account_label, o.health_status
         FROM coexistence.saved_sheets s
         LEFT JOIN coexistence.oauth_credentials o ON o.id = s.google_account_id
         ${where}
        ORDER BY s.name ASC`,
      params,
    );
    res.json(rows.map(shape));
  } catch (err) {
    console.error('[saved-sheets] list error:', err.message);
    res.status(500).json({ error: 'Failed to list saved sheets' });
  }
});

// GET /saved-sheets/:id/headers — the tab's column names.
//
// Reads a KNOWN spreadsheet id, so this needs only the `spreadsheets` scope —
// no Drive browse permission. That's the whole bonus of the library: an account
// that can't list spreadsheets can still use a saved one.
router.get('/saved-sheets/:id/headers', async (req, res) => {
  try {
    const params = [req.params.id];
    const scope = scopeClause(req, null, params);
    const { rows } = await pool.query(
      `SELECT * FROM coexistence.saved_sheets WHERE id = $1${scope}`,
      params,
    );
    if (!rows.length) return res.status(404).json({ error: 'Saved sheet not found' });
    const s = rows[0];
    const out = await googleSheets.getRows({
      credentialId: s.google_account_id,
      spreadsheetId: s.spreadsheet_id,
      sheetName: s.sheet_name,
      args: { max_rows: 1 },
    });
    res.json({ headers: (out.headers || []).filter(h => String(h || '').trim()) });
  } catch (err) {
    if (err.code === 'NO_HEADER' || /header row/i.test(err.message || '')) {
      return res.status(409).json({ error: err.message, code: 'NO_HEADER' });
    }
    console.error('[saved-sheets] headers error:', err.message);
    res.status(500).json({ error: 'Could not read that sheet’s columns' });
  }
});

// POST /saved-sheets — admin. Body: { name, googleAccountId, spreadsheetId, spreadsheetName?, sheetName }
router.post('/saved-sheets', adminOnly, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give it a name — that’s what people will pick.' });
  if (!b.googleAccountId || !b.spreadsheetId || !b.sheetName) {
    return res.status(400).json({ error: 'Pick a Google account, spreadsheet and tab.' });
  }
  try {
    // The account must belong to this workspace — otherwise a saved sheet could
    // point the whole tenant at someone else's credential.
    const params = [b.googleAccountId];
    const scope = scopeClause(req, null, params);
    const { rows: acct } = await pool.query(
      `SELECT id FROM coexistence.oauth_credentials WHERE id = $1 AND provider = 'google'${scope}`,
      params,
    );
    if (!acct.length) return res.status(404).json({ error: 'Google account not found' });

    const { rows } = await pool.query(
      `INSERT INTO coexistence.saved_sheets
         (name, google_account_id, spreadsheet_id, spreadsheet_name, sheet_name, tenant_id, organization_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, b.googleAccountId, b.spreadsheetId, b.spreadsheetName || null, b.sheetName,
       req.tenantId ?? null, req.organizationId ?? null, req.user.id],
    );
    res.status(201).json(shape(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `A saved sheet called “${name}” already exists.` });
    console.error('[saved-sheets] create error:', err.message);
    res.status(500).json({ error: 'Failed to save this sheet' });
  }
});

// PUT /saved-sheets/:id — admin. Rename, or re-point at a different sheet.
router.put('/saved-sheets/:id', adminOnly, async (req, res) => {
  const b = req.body || {};
  try {
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;
    const push = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };
    if (b.name !== undefined) {
      const n = String(b.name).trim();
      if (!n) return res.status(400).json({ error: 'Name cannot be empty' });
      push('name', n);
    }
    if (b.googleAccountId !== undefined) push('google_account_id', b.googleAccountId);
    if (b.spreadsheetId !== undefined) push('spreadsheet_id', b.spreadsheetId);
    if (b.spreadsheetName !== undefined) push('spreadsheet_name', b.spreadsheetName || null);
    if (b.sheetName !== undefined) push('sheet_name', b.sheetName);
    if (sets.length === 1) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    const idIdx = i;
    const scope = scopeClause(req, null, params);
    const { rows } = await pool.query(
      `UPDATE coexistence.saved_sheets SET ${sets.join(', ')} WHERE id = $${idIdx}${scope} RETURNING *`,
      params,
    );
    if (!rows.length) return res.status(404).json({ error: 'Saved sheet not found' });
    res.json(shape(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A saved sheet with that name already exists.' });
    console.error('[saved-sheets] update error:', err.message);
    res.status(500).json({ error: 'Failed to update this saved sheet' });
  }
});

// DELETE /saved-sheets/:id — admin.
//
// Safe by construction: pickers COPY the ids onto the node, so a flow already
// using this sheet keeps working. The entry just stops appearing in the picker.
router.delete('/saved-sheets/:id', adminOnly, async (req, res) => {
  try {
    const params = [req.params.id];
    const scope = scopeClause(req, null, params);
    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.saved_sheets WHERE id = $1${scope}`,
      params,
    );
    if (!rowCount) return res.status(404).json({ error: 'Saved sheet not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[saved-sheets] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete this saved sheet' });
  }
});

module.exports = { router };
