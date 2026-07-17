// Scheduled automation triggers: run a flow on a clock.
//
// THE FAN-OUT, and why there is no loop node.
//
// n8n fires a workflow once, with no subject. Here every step needs a contact —
// the whole engine is per-contact. So a schedule resolves an AUDIENCE and starts
// ONE EXECUTION PER CONTACT. That replaces n8n's loop node and is strictly
// better here: each contact gets its own execution row, its own step log, and
// error isolation, so one bad row can't abort the other 999.
//
// THE LEASING, and why a fixed lease is not enough.
//
// A 1000-contact fan-out can run ~30 minutes and outlive any fixed lease. The
// next tick would then re-claim it and message everyone a SECOND time. So:
//   * a fencing token — the fan-out re-checks it and ABORTS if it ever loses
//     ownership, rather than carrying on writing;
//   * a heartbeat renewing the lease mid-run, not a lease set once;
//   * release only if we still hold the token — otherwise a slow run clears the
//     lease of the run that replaced it and a third starts concurrently.
//
// The slot is stamped AT CLAIM, before fanning out: a crash should forfeit the
// slot, not replay it to everyone.

const crypto = require('crypto');
const pool = require('../db');
const { shouldFire, seedFiredDate } = require('./scheduleTiming');
const googleSheets = require('./googleSheets');

const SWEEP_INTERVAL_MS = parseInt(process.env.SCHEDULE_SWEEP_INTERVAL_MS || '', 10) || 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;          // renewed by the heartbeat below
const HEARTBEAT_MS = 60 * 1000;
// Hard ceiling regardless of what the operator typed. A schedule is the easiest
// way to accidentally message thousands of people at 9am.
const HARD_MAX_CONTACTS = parseInt(process.env.SCHEDULE_MAX_CONTACTS || '', 10) || 500;

async function findScheduleTriggers() {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.config, c.tenant_id, c.organization_id
       FROM coexistence.chatbots c
      WHERE c.status = 'active'
        AND c.config -> 'nodes' @> '[{"triggerKind":"schedule"}]'::jsonb`
  );
  return rows.map(r => {
    const trigger = (r.config?.nodes || []).find(n => n.type === 'trigger' && n.triggerKind === 'schedule');
    return trigger ? { automation: r, trigger } : null;
  }).filter(Boolean);
}

/**
 * Claim the slot. Atomic: the UPDATE only succeeds if nobody else holds a live
 * lease, so two workers racing the same tick can't both win.
 *
 * Stamps last_fired_date HERE, before any fan-out — a crash forfeits the slot
 * rather than replaying it.
 *
 * @returns the fencing token, or null if we lost the race.
 */
async function claimSlot(chatbotId, slotDate, tz) {
  const token = crypto.randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO coexistence.schedule_trigger_state
       (chatbot_id, last_fired_date, last_fired_at, last_fired_tz, lease_token, lease_expires_at, updated_at)
     VALUES ($1, $2, NOW(), $3, $4, NOW() + make_interval(secs => $5), NOW())
     ON CONFLICT (chatbot_id) DO UPDATE
       SET last_fired_date = EXCLUDED.last_fired_date,
           last_fired_at = NOW(),
           last_fired_tz = EXCLUDED.last_fired_tz,
           lease_token = EXCLUDED.lease_token,
           lease_expires_at = EXCLUDED.lease_expires_at,
           updated_at = NOW()
       WHERE coexistence.schedule_trigger_state.last_fired_date IS DISTINCT FROM EXCLUDED.last_fired_date
         AND (coexistence.schedule_trigger_state.lease_token IS NULL
              OR coexistence.schedule_trigger_state.lease_expires_at < NOW())
     RETURNING lease_token`,
    [chatbotId, slotDate, tz, token, LEASE_MS / 1000],
  );
  return rows.length ? rows[0].lease_token : null;
}

/** Do we still own this run? The fencing check. */
async function stillOwns(chatbotId, token) {
  const { rows } = await pool.query(
    'SELECT 1 FROM coexistence.schedule_trigger_state WHERE chatbot_id = $1 AND lease_token = $2',
    [chatbotId, token],
  );
  return rows.length > 0;
}

async function renewLease(chatbotId, token) {
  const { rowCount } = await pool.query(
    `UPDATE coexistence.schedule_trigger_state
        SET lease_expires_at = NOW() + make_interval(secs => $3), updated_at = NOW()
      WHERE chatbot_id = $1 AND lease_token = $2`,
    [chatbotId, token, LEASE_MS / 1000],
  );
  return rowCount > 0;
}

/** Release ONLY if we still hold it — see the header. */
async function releaseLease(chatbotId, token, { contacts = null, error = null } = {}) {
  await pool.query(
    `UPDATE coexistence.schedule_trigger_state
        SET lease_token = NULL, lease_expires_at = NULL,
            last_run_contacts = COALESCE($3, last_run_contacts),
            last_error = $4, updated_at = NOW()
      WHERE chatbot_id = $1 AND lease_token = $2`,
    [chatbotId, token, contacts, error],
  );
}

/**
 * Resolve the audience — one entry per execution.
 *
 * Modes:
 *   sheet    — a row per contact; the phone column names the recipient and every
 *              column becomes a {{variable}}.
 *   contacts — filtered contacts (by tag).
 *   once     — a single run with NO contact, for API/Sheets-only flows. Messaging
 *              steps will fail; the builder says so.
 */
async function resolveAudience(trigger, tenantId) {
  const mode = trigger.audienceMode || 'contacts';
  const cap = Math.min(parseInt(trigger.maxPerRun, 10) || HARD_MAX_CONTACTS, HARD_MAX_CONTACTS);

  if (mode === 'once') return { rows: [{}], truncated: false, total: 1 };

  if (mode === 'sheet') {
    if (!trigger.googleAccountId || !trigger.spreadsheetId || !trigger.sheetName) {
      throw new Error('This schedule has no sheet selected.');
    }
    const out = await googleSheets.runOp('getRows', {
      credentialId: trigger.googleAccountId,
      spreadsheetId: trigger.spreadsheetId,
      sheetName: trigger.sheetName,
      args: { max_rows: cap },
    });
    const rows = (out.rows || []).map(r => ({
      contactNumber: trigger.phoneColumn ? String(r[trigger.phoneColumn] ?? '').replace(/\D/g, '') : '',
      vars: r,
    }));
    return { rows: rows.slice(0, cap), truncated: out.truncated || rows.length > cap, total: rows.length };
  }

  // contacts
  //
  // NO TAGS SELECTED IS NOT "EVERYONE". An unfiltered audience here means a
  // half-configured test schedule messages the entire contact list at 09:00.
  // Refuse: the builder says the same thing at the point the choice is made.
  if (!Array.isArray(trigger.audienceTagIds) || trigger.audienceTagIds.length === 0) {
    throw new Error('This schedule has no audience tags selected — refusing to run it for every contact.');
  }

  const params = [];
  let where = 'WHERE 1=1';
  if (tenantId != null) { params.push(tenantId); where += ` AND c.tenant_id = $${params.length}`; }
  {
    // Match on id OR name, the same way the engine's Remove Tag does. A tag
    // entry on a contact can carry a missing or stale `id` (see
    // automationEngine.js: "legacy tag entries with a different/missing id"),
    // and an id-only match would silently drop those people from the campaign —
    // a smaller audience is indistinguishable from a smaller tag.
    const ids = trigger.audienceTagIds.map(Number).filter(Number.isFinite);
    const { rows: tagRows } = await pool.query(
      'SELECT id, name FROM coexistence.tags WHERE id = ANY($1::bigint[])', [ids],
    );
    if (tagRows.length === 0) {
      // The tag was deleted. Firing at "everyone" because the filter resolved to
      // nothing is the worst possible reading of this.
      throw new Error('None of this schedule’s audience tags still exist.');
    }
    params.push(tagRows.map(t => t.id));
    params.push(tagRows.map(t => String(t.name).toLowerCase()));
    where += ` AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(c.tags, '[]'::jsonb)) t
       -- The regex guard is load-bearing: a bare ::bigint cast throws on any
       -- non-numeric id in the JSONB and would take the whole sweep down.
       WHERE (CASE WHEN t->>'id' ~ '^[0-9]+$' THEN (t->>'id')::bigint END) = ANY($${params.length - 1}::bigint[])
          OR LOWER(t->>'name') = ANY($${params.length}::text[]))`;
  }
  params.push(cap + 1); // +1 so we can tell "exactly at the cap" from "truncated"
  const { rows } = await pool.query(
    `SELECT c.wa_number, c.contact_number, c.name, c.tags, c.custom_fields
       FROM coexistence.contacts c ${where}
      ORDER BY c.updated_at DESC LIMIT $${params.length}`,
    params,
  );
  const truncated = rows.length > cap;
  return {
    rows: rows.slice(0, cap).map(r => ({ contactNumber: r.contact_number, waNumber: r.wa_number, contact: r, vars: {} })),
    truncated,
    total: rows.length,
  };
}

/**
 * Fire one schedule. Returns { fired, skipped, contacts, truncated }.
 * Never throws — one broken schedule must not stop the rest.
 */
async function fireOne({ automation, trigger }, now = new Date()) {
  const { rows: st } = await pool.query(
    'SELECT * FROM coexistence.schedule_trigger_state WHERE chatbot_id = $1',
    [automation.id],
  );
  const state = st[0] || {};
  const verdict = shouldFire(trigger, state, now);
  if (!verdict.fire) return { skipped: verdict.reason };

  const tz = trigger.timezone || 'Asia/Kolkata';
  const token = await claimSlot(automation.id, verdict.slotDate, tz);
  // Lost the race, or the slot was already claimed. Not an error.
  if (!token) return { skipped: 'not_claimed' };

  // Renew the lease WHILE we run. A 1000-contact fan-out outlives any fixed
  // lease, and the next tick would then re-claim and message everyone twice.
  const heartbeat = setInterval(() => {
    renewLease(automation.id, token).catch(() => {});
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  let started = 0;
  try {
    const { rows: audience, truncated, total } = await resolveAudience(trigger, automation.tenant_id);
    if (truncated) {
      // Never silently. A capped run that reads as "we messaged everyone" is
      // how a campaign quietly misses half its list.
      console.warn(`[schedule] automation=${automation.id} audience TRUNCATED: ran ${audience.length} of ${total}+ (cap ${Math.min(parseInt(trigger.maxPerRun, 10) || HARD_MAX_CONTACTS, HARD_MAX_CONTACTS)})`);
    }

    for (const entry of audience) {
      // THE FENCING CHECK. If we lost the lease (a slow run got re-claimed),
      // ABORT — carrying on would double-message everyone still ahead of us.
      // eslint-disable-next-line no-await-in-loop
      if (!(await stillOwns(automation.id, token))) {
        console.warn(`[schedule] automation=${automation.id} LOST ITS LEASE after ${started} contact(s) — aborting the fan-out`);
        break;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await runOneExecution({ automation, trigger, entry });
        started++;
      } catch (err) {
        // Error isolation: one bad row must not abort the rest. This is exactly
        // what the fan-out buys over a loop node.
        console.error(`[schedule] automation=${automation.id} contact=${entry.contactNumber || '(none)'} failed: ${err.message}`);
      }
    }
    await releaseLease(automation.id, token, { contacts: started, error: null });
    return { fired: true, contacts: started, truncated };
  } catch (err) {
    await releaseLease(automation.id, token, { contacts: started, error: String(err.message || err).slice(0, 500) });
    return { fired: false, error: err.message };
  } finally {
    clearInterval(heartbeat);
  }
}

async function runOneExecution({ automation, trigger, entry }) {
  const { executeAutomation } = require('../engine/automationEngine');
  const client = await pool.connect();
  try {
    let waNumber = entry.waNumber || null;
    if (!waNumber) {
      const scoped = Array.isArray(trigger.triggerAccounts) ? trigger.triggerAccounts : [];
      const { rows: acc } = await client.query(
        // triggerAccounts holds DISPLAY PHONE NUMBERS, not ids — the builder's
        // checkbox stores acc.displayPhoneNumber, and automationEngine matches
        // it against messageRecord.wa_number. Casting these to bigint throws.
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
      waNumber = acc[0] ? String(acc[0].display_phone_number || '').replace(/\D/g, '') : null;
    }
    const context = {
      contact_number: entry.contactNumber || '',
      message_body: '',
      message_type: 'schedule',
      trigger_type: 'schedule',
      trigger_data: { wa_number: waNumber, contact_number: entry.contactNumber || '', sheet_row: entry.vars || {} },
      sheet_row: entry.vars || {},
    };
    if (entry.contact) {
      context.contact = {
        ...entry.contact,
        tags: entry.contact.tags || [],
        custom_fields: entry.contact.custom_fields || {},
      };
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

/**
 * Seed the fired-date when a schedule flow is ACTIVATED.
 *
 * Call this ONLY on the transition into 'active'. Two traps:
 *
 *   * Seeding today's date unconditionally silently SKIPS the first run — a
 *     whole week for a weekly, a month for a monthly. seedFiredDate() returns
 *     null when the slot is still ahead, so it fires today. See scheduleTiming.
 *
 *   * Seeding on every save (not just the transition) would move the goalposts
 *     under a schedule that is already running: activate at 08:00, save a typo
 *     at 09:30, and today's 09:00 slot gets marked done retroactively.
 *
 * We deliberately do NOT touch last_fired_at — the 20h min-gap guard reads it,
 * and clearing it on a re-activation would buy a second run for a slot that
 * already fired today.
 */
async function seedScheduleState(chatbotId, config, now = new Date()) {
  const trigger = (config?.nodes || []).find(n => n.type === 'trigger' && n.triggerKind === 'schedule');
  if (!trigger) return { seeded: false, reason: 'not_a_schedule' };

  const tz = trigger.timezone || 'Asia/Kolkata';
  const seed = seedFiredDate(trigger, now);
  const { rowCount } = await pool.query(
    `INSERT INTO coexistence.schedule_trigger_state
       (chatbot_id, last_fired_date, last_fired_tz, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (chatbot_id) DO UPDATE
       SET last_fired_date = EXCLUDED.last_fired_date,
           last_fired_tz = EXCLUDED.last_fired_tz,
           updated_at = NOW()
       -- Never yank the ground out from under a fan-out that is mid-run.
       WHERE coexistence.schedule_trigger_state.lease_token IS NULL
          OR coexistence.schedule_trigger_state.lease_expires_at < NOW()`,
    [chatbotId, seed, tz],
  );
  return { seeded: rowCount > 0, firedDate: seed, firesToday: seed === null };
}

async function sweepSchedules(now = new Date()) {
  const triggers = await findScheduleTriggers();
  if (triggers.length === 0) return { triggers: 0, fired: 0 };
  let fired = 0;
  let contacts = 0;
  for (const t of triggers) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fireOne(t, now);
    if (r.fired) { fired++; contacts += r.contacts || 0; }
  }
  return { triggers: triggers.length, fired, contacts };
}

function startScheduleSweeper() {
  const tick = () => {
    sweepSchedules()
      .then(({ fired, contacts }) => {
        if (fired > 0) console.log(`[schedule] fired ${fired} schedule(s), ${contacts} execution(s)`);
      })
      .catch(err => console.error('[schedule] sweep error:', err.message));
  };
  // Granularity is bounded by this interval — a schedule set to 09:00 fires
  // within a minute of it, not at 09:00:00. Presets, not cron expressions:
  // cron would need a dependency and buys nothing the presets don't cover.
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, SWEEP_INTERVAL_MS).unref();
  console.log(`[schedule] sweeper started, every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s`);
}

module.exports = {
  findScheduleTriggers,
  claimSlot,
  stillOwns,
  renewLease,
  releaseLease,
  resolveAudience,
  fireOne,
  seedScheduleState,
  sweepSchedules,
  startScheduleSweeper,
  HARD_MAX_CONTACTS,
};
