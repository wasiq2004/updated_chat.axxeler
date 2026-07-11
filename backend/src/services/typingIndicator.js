// Typing indicator ("… is typing") shown to the WhatsApp customer while a human
// agent composes a reply or an AI agent is generating one.
//
// Meta has no standalone typing endpoint: the indicator piggybacks on the
// mark-as-read call and requires the message_id of a recent INBOUND message from
// the customer. It renders for up to ~25s (or until our reply lands). We look up
// the latest inbound wamid, resolve the sender's credentials, and fire it.
//
// Best-effort by design: a missing inbound id, an expired 24h window, or a Meta
// rejection must never surface to the caller (composer keystrokes / agent runs).
// A per-conversation throttle keeps us well under Meta's rate limits — the
// indicator lasts ~25s so re-sending more often than every 18s is pointless.

const pool = require('../db');
const { resolveAccount } = require('./messageSender');
const { sendTypingIndicator } = require('../integrations/metaSend');

const THROTTLE_MS = 18000;
// key `${waNumber}|${contactNumber}` → last epoch ms we sent an indicator.
const lastSentAt = new Map();

// Periodically drop stale throttle entries so the map can't grow unbounded on a
// long-lived process. Unref so it never keeps the event loop alive.
const sweep = setInterval(() => {
  const cutoff = Date.now() - THROTTLE_MS * 4;
  for (const [k, t] of lastSentAt) if (t < cutoff) lastSentAt.delete(k);
}, 300000);
if (typeof sweep.unref === 'function') sweep.unref();

/**
 * Look up the wamid of the most recent inbound message from this contact. Only
 * Meta-issued ids (wamid.*) are usable; our optimistic `local-*` ids are skipped.
 * Returns null when there's nothing to attach the indicator to.
 */
async function latestInboundMessageId({ phoneNumberId, contactNumber }) {
  const norm = String(contactNumber).replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT message_id
       FROM coexistence.chat_history
      WHERE phone_number_id = $1
        AND contact_number = $2
        AND direction = 'incoming'
        AND message_id LIKE 'wamid.%'
      ORDER BY timestamp DESC
      LIMIT 1`,
    [phoneNumberId, norm]
  );
  return rows[0]?.message_id || null;
}

/**
 * Show the typing indicator for (waNumber → contactNumber). Throttled per
 * conversation; never throws. Returns true if an indicator was actually sent.
 */
async function showTyping({ waNumber, contactNumber }) {
  try {
    const wa = String(waNumber || '').replace(/\D/g, '');
    const contact = String(contactNumber || '').replace(/\D/g, '');
    if (!wa || !contact) return false;

    const key = `${wa}|${contact}`;
    const now = Date.now();
    const prev = lastSentAt.get(key);
    if (prev && now - prev < THROTTLE_MS) return false;
    // Reserve the slot before the async work so concurrent callers don't race
    // through the throttle window (keystrokes + agent run firing together).
    lastSentAt.set(key, now);

    const { account, error } = await resolveAccount({ fromPhoneNumber: wa });
    if (error || !account) { lastSentAt.delete(key); return false; }

    const messageId = await latestInboundMessageId({
      phoneNumberId: account.phoneNumberId,
      contactNumber: contact,
    });
    if (!messageId) { lastSentAt.delete(key); return false; }

    await sendTypingIndicator({
      accessToken: account.accessToken,
      phoneNumberId: account.phoneNumberId,
      messageId,
    });
    return true;
  } catch {
    // Expired id / closed window / transient Meta error — indicator is cosmetic.
    return false;
  }
}

module.exports = { showTyping };
