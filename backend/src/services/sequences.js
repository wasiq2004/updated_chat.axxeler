// Follow-up sequences: timed template drips a contact is enrolled in (migration
// 070). The automation actions Start/Pause/End Sequence call enroll/pause/end;
// a 60s sweeper sends the next step of every due active enrollment via the
// shared outbound queue and schedules the following one.

const pool = require('../db');

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

function stepDelayMs(step) {
  const v = Math.max(0, parseInt(step?.delayValue ?? 0, 10) || 0);
  return v * (UNIT_MS[step?.delayUnit] || UNIT_MS.hours);
}

// Enroll (or re-activate) a contact in a sequence by id or (case-insensitive)
// name. Scheduling starts from NOW + step[0] delay.
async function enroll({ sequenceRef, waNumber, contactNumber, tenantId = null }) {
  const seq = await findSequence(sequenceRef, tenantId);
  if (!seq) return { ok: false, error: `Sequence "${sequenceRef}" not found` };
  if (!seq.is_active) return { ok: false, error: `Sequence "${seq.name}" is disabled` };
  const steps = Array.isArray(seq.steps) ? seq.steps : [];
  if (steps.length === 0) return { ok: false, error: `Sequence "${seq.name}" has no steps` };

  const firstDue = new Date(Date.now() + stepDelayMs(steps[0]));
  await pool.query(
    `INSERT INTO coexistence.sequence_enrollments
       (sequence_id, wa_number, contact_number, status, next_step, next_send_at, tenant_id)
     VALUES ($1, $2, $3, 'active', 0, $4, $5)
     ON CONFLICT (sequence_id, wa_number, contact_number) DO UPDATE
       SET status = 'active', next_step = 0, next_send_at = EXCLUDED.next_send_at, updated_at = NOW()`,
    [seq.id, waNumber, contactNumber, firstDue, tenantId ?? seq.tenant_id ?? null]
  );
  return { ok: true, sequence: { id: seq.id, name: seq.name }, nextSendAt: firstDue };
}

// Pause / end every enrollment of this contact (optionally scoped to one sequence).
async function setStatusForContact({ waNumber, contactNumber, status, sequenceRef = null, tenantId = null }) {
  let seqId = null;
  if (sequenceRef) {
    const seq = await findSequence(sequenceRef, tenantId);
    if (!seq) return { ok: false, error: `Sequence "${sequenceRef}" not found` };
    seqId = seq.id;
  }
  const { rowCount } = await pool.query(
    `UPDATE coexistence.sequence_enrollments
        SET status = $1, updated_at = NOW()
      WHERE wa_number = $2 AND contact_number = $3
        AND status IN ('active','paused')
        AND ($4::bigint IS NULL OR sequence_id = $4)`,
    [status, waNumber, contactNumber, seqId]
  );
  return { ok: true, updated: rowCount };
}

async function findSequence(ref, tenantId) {
  const asId = parseInt(ref, 10);
  const params = [];
  let where;
  if (Number.isInteger(asId) && String(asId) === String(ref).trim()) {
    params.push(asId); where = `id = $1`;
  } else {
    params.push(String(ref).trim()); where = `LOWER(name) = LOWER($1)`;
  }
  if (tenantId != null) { params.push(tenantId); where += ` AND tenant_id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT id, name, is_active, steps, tenant_id FROM coexistence.sequences WHERE ${where} ORDER BY id LIMIT 1`,
    params
  );
  return rows[0] || null;
}

// ── Sweeper ───────────────────────────────────────────────────────────────────
// Sends the due step of every active enrollment, then advances/completes it.
// Respects contact subscription (unsubscribed contacts are skipped + ended).
async function sweepDueEnrollments() {
  const { rows: due } = await pool.query(
    `SELECT e.id, e.sequence_id, e.wa_number, e.contact_number, e.next_step,
            s.steps, s.is_active
       FROM coexistence.sequence_enrollments e
       JOIN coexistence.sequences s ON s.id = e.sequence_id
      WHERE e.status = 'active' AND e.next_send_at <= NOW()
      ORDER BY e.next_send_at
      LIMIT 50`
  );
  let sent = 0;
  for (const row of due) {
    try {
      const steps = Array.isArray(row.steps) ? row.steps : [];
      const step = steps[row.next_step];
      if (!row.is_active || !step) {
        await pool.query(`UPDATE coexistence.sequence_enrollments SET status='completed', updated_at=NOW() WHERE id=$1`, [row.id]);
        continue;
      }
      // Unsubscribed contacts drop out of drips.
      const { rows: sub } = await pool.query(
        `SELECT subscribed FROM coexistence.contacts WHERE wa_number=$1 AND contact_number=$2`,
        [row.wa_number, row.contact_number]
      );
      if (sub.length && sub[0].subscribed === false) {
        await pool.query(`UPDATE coexistence.sequence_enrollments SET status='ended', updated_at=NOW() WHERE id=$1`, [row.id]);
        continue;
      }

      const { rows: tplRows } = await pool.query(
        `SELECT id, name, language, body FROM coexistence.message_templates WHERE id = $1 AND status = 'APPROVED'`,
        [parseInt(step.templateId, 10)]
      );
      const tpl = tplRows[0];
      if (tpl) {
        const { resolveAccount, insertPendingRow } = require('./messageSender');
        const { enqueueSend } = require('../queue/sendQueue');
        const { account, error } = await resolveAccount({ fromPhoneNumber: row.wa_number });
        if (!error && account) {
          const localId = await insertPendingRow({
            account, toNumber: row.contact_number, messageType: 'template', messageBody: tpl.body,
          });
          await enqueueSend({
            kind: 'template', accountId: account.id,
            to: String(row.contact_number).replace(/\D/g, ''),
            localMessageId: localId,
            payload: { name: tpl.name, languageCode: tpl.language || 'en', components: [] },
          }, { delayMs: 0 });
          sent++;
        }
      }
      // Advance to the next step or complete.
      const nextIdx = row.next_step + 1;
      if (nextIdx >= steps.length) {
        await pool.query(`UPDATE coexistence.sequence_enrollments SET status='completed', next_send_at=NULL, updated_at=NOW() WHERE id=$1`, [row.id]);
      } else {
        const nextAt = new Date(Date.now() + stepDelayMs(steps[nextIdx]));
        await pool.query(
          `UPDATE coexistence.sequence_enrollments SET next_step=$2, next_send_at=$3, updated_at=NOW() WHERE id=$1`,
          [row.id, nextIdx, nextAt]
        );
      }
    } catch (err) {
      console.error(`[sequences] sweep enrollment ${row.id} failed:`, err.message);
      // Push the retry 10 minutes out so one broken row can't hot-loop the sweeper.
      await pool.query(
        `UPDATE coexistence.sequence_enrollments SET next_send_at = NOW() + INTERVAL '10 minutes', updated_at=NOW() WHERE id=$1`,
        [row.id]
      ).catch(() => {});
    }
  }
  return sent;
}

function startSequenceSweeper() {
  setInterval(() => {
    sweepDueEnrollments()
      .then(n => { if (n > 0) console.log(`[sequences] sent ${n} due step(s)`); })
      .catch(err => console.error('[sequences] sweeper error:', err.message));
  }, 60 * 1000).unref();
}

module.exports = { enroll, setStatusForContact, sweepDueEnrollments, startSequenceSweeper, findSequence };
