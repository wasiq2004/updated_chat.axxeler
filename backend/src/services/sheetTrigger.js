// Google Sheets polling trigger.
//
// Sheets has no row-change webhook, and Drive's watch API only says "this file
// changed" with no row detail. So the only honest way to know WHICH rows changed
// is to read the tab and diff it against a stored snapshot. This is that poller.
//
// Every non-obvious decision here is defending against a specific failure:
//
//   * Identity comes from a USER-CHOSEN KEY COLUMN, not the row number. Sorting
//     a sheet renumbers every row; against row numbers that reads as "all rows
//     changed" and re-fires the entire tab.
//
//   * Duplicate key values get DISTINCT identities (#2, #3…). Keying them both
//     as "919876543210" means the second silently OVERWRITES the first in the
//     snapshot — and then the first row's edits are invisible forever, because
//     the stored hash always belongs to whichever row was read last. That is the
//     quiet version of this bug and the one that actually happens; see
//     test/sheetTrigger.test.js.
//
//     KNOWN LIMITATION, deliberate: the #N suffix follows SHEET ORDER, so
//     re-sorting rows that share a key value swaps their identities and fires
//     both spuriously. There is no fix at this layer — when the key doesn't
//     identify the row, "row A was edited" and "row A deleted, row C added" are
//     genuinely indistinguishable. Content-hash identities would trade this for
//     an edit looking like an add. The UI therefore asks for a column with
//     unique values, which is the real answer. Rows with a UNIQUE key are fully
//     re-sort stable (tested).
//
//   * The first poll BASELINES and fires nothing. Activating against a 500-row
//     sheet must not blast 500 executions.
//
//   * Events per tick are CAPPED, and what was deferred is logged. Silent
//     truncation reads as "we covered everything".
//
//   * modifiedTime is checked first. An unchanged file costs one small Drive
//     call instead of a full values read.

const crypto = require('crypto');
const pool = require('../db');
const googleSheets = require('./googleSheets');
const { google } = require('googleapis');
const { getAccessToken } = require('./googleAuth');

const { normCell, keyMatch, parseStart, locateHeader, MAX_COL, MAX_ROW } = googleSheets._internals;

// Per tick, per trigger. A sheet that gains 5,000 rows at once is a paste, not
// 5,000 customers — firing all of them would flood the queue and, if they're
// messaging steps, the customer's phone.
const MAX_EVENTS_PER_TICK = parseInt(process.env.SHEET_TRIGGER_MAX_EVENTS || '', 10) || 25;
const POLL_INTERVAL_MS = parseInt(process.env.SHEET_TRIGGER_INTERVAL_MS || '', 10) || 60 * 1000;
// After this many consecutive failures we stop polling that trigger until it
// changes. A credential that has been revoked will never recover on its own, and
// hammering it every 60s just fills the log.
const MAX_CONSECUTIVE_ERRORS = 5;

function hashRow(cells) {
  return crypto.createHash('sha1').update(JSON.stringify(cells.map(c => String(c ?? '')))).digest('hex').slice(0, 16);
}

/**
 * Turn a tab's values into { identity -> {hash, row} }.
 *
 * Exported for tests: this is the function every trap lives in, and it is pure.
 */
function snapshotRows(rows, keyColumn) {
  const hIdx = locateHeader(rows, keyColumn);
  if (hIdx === -1) {
    const err = new Error(`Could not find a header row containing "${keyColumn}".`);
    err.code = 'NO_HEADER';
    throw err;
  }
  const header = rows[hIdx];
  const keyCol = header.findIndex(c => normCell(c) === normCell(keyColumn));
  const out = {};
  const seen = new Map(); // key value -> how many times we've seen it

  for (let i = hIdx + 1; i < rows.length; i++) {
    const cells = rows[i] || [];
    if (!cells.some(c => String(c ?? '').trim() !== '')) continue; // blank row
    const raw = String(cells[keyCol] ?? '').trim();
    // A row with no key can't have a stable identity across a re-sort. Skipping
    // it is the only honest option — inventing one from the row number would
    // re-fire it on every sort.
    if (!raw) continue;

    const n = (seen.get(normCell(raw)) || 0) + 1;
    seen.set(normCell(raw), n);
    // THE DUPLICATE-KEY TRAP: two rows sharing "919876543210" must not map to
    // the same identity — the second would overwrite the first in the snapshot,
    // and the first row's edits would then never be seen again.
    const identity = n === 1 ? raw : `${raw}#${n}`;

    const asObject = {};
    header.forEach((h, ci) => { if (String(h ?? '').trim()) asObject[String(h).trim()] = cells[ci] ?? ''; });

    out[identity] = { hash: hashRow(cells), row: asObject, keyValue: raw };
  }
  return { header, identities: out };
}

/**
 * Diff a fresh snapshot against the stored hashes.
 * Returns { added, updated } — identities and their row objects.
 *
 * Deliberately does NOT report removals: a deleted row is not an event anyone
 * asked for, and treating it as one would fire flows for rows that no longer
 * exist.
 */
function diffSnapshot(prevHashes, identities) {
  const added = [];
  const updated = [];
  for (const [identity, cur] of Object.entries(identities)) {
    const before = prevHashes[identity];
    if (before === undefined) added.push({ identity, ...cur });
    else if (before !== cur.hash) updated.push({ identity, ...cur });
  }
  return { added, updated };
}

async function driveModifiedTime(credentialId, spreadsheetId) {
  const token = await getAccessToken(credentialId);
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: token });
  const drive = google.drive({ version: 'v3', auth: oauth2 });
  const { data } = await drive.files.get({ fileId: spreadsheetId, fields: 'modifiedTime' });
  return data.modifiedTime || null;
}

async function readTab(credentialId, spreadsheetId, sheetName) {
  const token = await getAccessToken(credentialId);
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: token });
  const sheets = google.sheets({ version: 'v4', auth: oauth2 });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:${MAX_COL}${MAX_ROW}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return data.values || [];
}

/**
 * Every enabled automation whose trigger node is a sheet trigger.
 *
 * Resolved by TENANT, not by user: a poller has no req.user, and the
 * route-level `user_id` guard would find nothing.
 */
async function findSheetTriggers() {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.config, c.tenant_id, c.organization_id
       FROM coexistence.chatbots c
      WHERE c.status = 'active'
        AND c.config -> 'nodes' @> '[{"triggerKind":"sheetRow"}]'::jsonb`
  );
  return rows.map(r => {
    const nodes = r.config?.nodes || [];
    const trigger = nodes.find(n => n.type === 'trigger' && n.triggerKind === 'sheetRow');
    return trigger ? { automation: r, trigger } : null;
  }).filter(Boolean);
}

async function loadState(chatbotId, spreadsheetId, sheetName) {
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.sheet_trigger_state
      WHERE chatbot_id = $1 AND spreadsheet_id = $2 AND sheet_name = $3`,
    [chatbotId, spreadsheetId, sheetName],
  );
  return rows[0] || null;
}

/**
 * Poll one trigger. Returns { fired, deferred, baselined, skipped }.
 * Never throws — a broken trigger must not stop the others.
 */
async function pollOne({ automation, trigger }, { onEvent }) {
  const googleAccountId = trigger.googleAccountId;
  const spreadsheetId = trigger.spreadsheetId;
  const sheetName = trigger.sheetName;
  const keyColumn = trigger.keyColumn;
  const watch = trigger.sheetWatch || 'added';   // 'added' | 'updated' | 'both'

  if (!googleAccountId || !spreadsheetId || !sheetName || !keyColumn) {
    return { skipped: 'not_configured' };
  }

  // A credential googleAuth has already marked broken will not fix itself.
  const { rows: cred } = await pool.query(
    `SELECT health_status FROM coexistence.oauth_credentials WHERE id = $1`,
    [googleAccountId],
  );
  if (!cred.length) return { skipped: 'no_credential' };
  if (cred[0].health_status === 'error') return { skipped: 'credential_unhealthy' };

  let state = await loadState(automation.id, spreadsheetId, sheetName);
  if (!state) {
    const { rows } = await pool.query(
      `INSERT INTO coexistence.sheet_trigger_state (chatbot_id, google_account_id, spreadsheet_id, sheet_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chatbot_id, spreadsheet_id, sheet_name) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [automation.id, googleAccountId, spreadsheetId, sheetName],
    );
    state = rows[0];
  }
  if (state.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) return { skipped: 'too_many_errors' };

  try {
    // Cheap probe first. An untouched sheet costs one small Drive call.
    const modified = await driveModifiedTime(googleAccountId, spreadsheetId);
    if (state.baselined_at && modified && modified === state.last_modified_time) {
      await pool.query(
        `UPDATE coexistence.sheet_trigger_state SET last_polled_at = NOW(), last_error = NULL, consecutive_errors = 0 WHERE id = $1`,
        [state.id],
      );
      return { skipped: 'unchanged' };
    }

    const rows = await readTab(googleAccountId, spreadsheetId, sheetName);
    const { identities } = snapshotRows(rows, keyColumn);
    const nextHashes = Object.fromEntries(Object.entries(identities).map(([k, v]) => [k, v.hash]));

    // THE BASELINE TRAP: the first successful poll records state and fires
    // NOTHING. Otherwise activating against an existing 500-row sheet starts 500
    // executions — quite possibly 500 WhatsApp messages.
    if (!state.baselined_at) {
      await pool.query(
        `UPDATE coexistence.sheet_trigger_state
            SET row_hashes = $2::jsonb, baselined_at = NOW(), last_modified_time = $3,
                last_polled_at = NOW(), last_error = NULL, consecutive_errors = 0, updated_at = NOW()
          WHERE id = $1`,
        [state.id, JSON.stringify(nextHashes), modified],
      );
      return { baselined: Object.keys(nextHashes).length, fired: 0 };
    }

    const { added, updated } = diffSnapshot(state.row_hashes || {}, identities);
    let events = [];
    if (watch === 'added') events = added;
    else if (watch === 'updated') events = updated;
    else events = [...added, ...updated];

    const toFire = events.slice(0, MAX_EVENTS_PER_TICK);
    const deferred = events.length - toFire.length;

    for (const ev of toFire) {
      // eslint-disable-next-line no-await-in-loop
      await onEvent({ automation, trigger, event: ev, isNew: added.includes(ev) });
    }

    // Only the fired rows advance the snapshot. A deferred row keeps its old
    // hash, so the next tick still sees it as new and picks it up — that's how
    // the cap defers rather than drops.
    const advanced = { ...(state.row_hashes || {}) };
    for (const ev of toFire) advanced[ev.identity] = ev.hash;
    // Rows that vanished from the sheet are pruned, or the snapshot grows
    // forever and a re-added row would never fire again.
    for (const id of Object.keys(advanced)) {
      if (!identities[id] && !toFire.some(e => e.identity === id)) delete advanced[id];
    }

    await pool.query(
      `UPDATE coexistence.sheet_trigger_state
          SET row_hashes = $2::jsonb,
              last_modified_time = $3,
              last_polled_at = NOW(), last_error = NULL, consecutive_errors = 0, updated_at = NOW()
        WHERE id = $1`,
      // Only claim modifiedTime when nothing was deferred — otherwise the next
      // tick would see "unchanged" and never pick the rest up.
      [state.id, JSON.stringify(advanced), deferred > 0 ? null : modified],
    );

    if (deferred > 0) {
      console.warn(`[sheet-trigger] automation=${automation.id} fired ${toFire.length}, DEFERRED ${deferred} to the next tick (cap ${MAX_EVENTS_PER_TICK})`);
    }
    return { fired: toFire.length, deferred };
  } catch (err) {
    await pool.query(
      `UPDATE coexistence.sheet_trigger_state
          SET last_error = $2, consecutive_errors = consecutive_errors + 1, last_polled_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [state.id, String(err.message || err).slice(0, 500)],
    ).catch(() => {});
    return { error: err.message };
  }
}

/** One sweep across every configured sheet trigger. */
async function sweepSheetTriggers({ onEvent }) {
  const triggers = await findSheetTriggers();
  if (triggers.length === 0) return { triggers: 0, fired: 0 };
  let fired = 0;
  for (const t of triggers) {
    // eslint-disable-next-line no-await-in-loop
    const r = await pollOne(t, { onEvent });
    fired += r.fired || 0;
  }
  return { triggers: triggers.length, fired };
}

/**
 * Start one execution for a changed row.
 *
 * A run is per contact (the whole engine assumes it), so the operator names a
 * PHONE COLUMN. Without one the row's steps can still run — Sheets/API steps
 * don't need a contact — but any messaging step will fail for want of a number,
 * which the builder warns about rather than silently dropping.
 *
 * The row's columns become {{variables}}, so a flow can message
 * "Hi {{Name}}, your order {{Order ID}} shipped".
 */
async function runAutomationForRow({ automation, trigger, event, isNew }) {
  const { executeAutomation } = require('../engine/automationEngine');
  const row = event.row || {};
  const phoneCol = trigger.phoneColumn;
  const contactNumber = phoneCol ? String(row[phoneCol] ?? '').replace(/\D/g, '') : '';

  const client = await pool.connect();
  try {
    // The account this flow's messages would go out from — same resolution as
    // the inbound webhook trigger, which has the same "no conversation to
    // inherit from" problem.
    const scoped = Array.isArray(trigger.triggerAccounts) ? trigger.triggerAccounts : [];
    const { rows: acc } = await client.query(
      // triggerAccounts holds DISPLAY PHONE NUMBERS, not ids — the builder's
      // checkbox stores acc.displayPhoneNumber, and automationEngine matches it
      // against messageRecord.wa_number. Casting these to bigint throws.
      // Compare digits-only on both sides: the stored value is formatted.
      scoped.length
        ? `SELECT display_phone_number FROM coexistence.whatsapp_accounts
            WHERE is_active = TRUE
              AND regexp_replace(display_phone_number,'[^0-9]','','g') = ANY($1::text[])
            ORDER BY is_default DESC, id LIMIT 1`
        : `SELECT display_phone_number FROM coexistence.whatsapp_accounts
            WHERE is_active = TRUE ORDER BY is_default DESC, id LIMIT 1`,
      scoped.length ? [scoped.map(p => String(p).replace(/\D/g, ''))] : [],
    );
    const waNumber = acc[0] ? String(acc[0].display_phone_number || '').replace(/\D/g, '') : null;

    const context = {
      contact_number: contactNumber,
      message_body: '',
      message_type: 'sheet_row',
      trigger_type: 'sheetRow',
      trigger_data: {
        wa_number: waNumber,
        contact_number: contactNumber,
        sheet_row: row,
        row_identity: event.identity,
        change: isNew ? 'added' : 'updated',
      },
      // Every column, addressable as {{Column Name}}.
      sheet_row: row,
    };
    if (contactNumber && waNumber) {
      try {
        const { rows: c } = await client.query(
          `SELECT name, profile_name, tags, custom_fields FROM coexistence.contacts
            WHERE wa_number = $1 AND contact_number = $2 LIMIT 1`,
          [waNumber, contactNumber],
        );
        if (c.length) context.contact = { ...c[0], contact_number: contactNumber, tags: c[0].tags || [], custom_fields: c[0].custom_fields || {} };
      } catch { /* run without contact context */ }
    }
    try {
      const { rows: fd } = await client.query('SELECT id, name FROM coexistence.contact_field_definitions');
      context.field_defs = fd;
    } catch { context.field_defs = []; }

    await executeAutomation(client, automation, context);
  } finally {
    client.release();
  }
}

function startSheetTriggerPoller(onEvent = runAutomationForRow) {
  const tick = () => {
    sweepSheetTriggers({ onEvent })
      .then(({ triggers, fired }) => {
        if (fired > 0) console.log(`[sheet-trigger] ${fired} row event(s) across ${triggers} trigger(s)`);
      })
      .catch(err => console.error('[sheet-trigger] sweep error:', err.message));
  };
  // Boot delay, not an immediate run: findSheetTriggers gates on there being any
  // configured, so an install with none makes zero Google calls forever.
  setTimeout(tick, 45 * 1000).unref();
  setInterval(tick, POLL_INTERVAL_MS).unref();
  console.log(`[sheet-trigger] poller started, every ${Math.round(POLL_INTERVAL_MS / 1000)}s`);
}

module.exports = {
  snapshotRows,
  diffSnapshot,
  pollOne,
  sweepSheetTriggers,
  startSheetTriggerPoller,
  runAutomationForRow,
  MAX_EVENTS_PER_TICK,
};
