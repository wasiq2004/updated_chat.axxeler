// Public inbound-webhook trigger for automations.
//
//   POST /api/hooks/automation/:secret
//
// The :secret is a per-automation token stored on the flow's Webhook trigger
// node (node.webhookSecret, generated in the builder). The payload's top-level
// fields become {{variables}} downstream; `contact_phone` (or `phone`) targets
// which WhatsApp contact the flow runs for — required so message nodes have a
// recipient. Auth is the unguessable secret itself (same model as Meta webhook
// verify tokens); a bad secret 404s without revealing anything.

const { Router } = require('express');
const pool = require('../db');
const { executeAutomation } = require('../engine/automationEngine');

const publicRouter = Router();

publicRouter.post('/hooks/automation/:secret', async (req, res) => {
  const secret = String(req.params.secret || '');
  // Secrets are whsec_<24+ hex> — refuse trivially short paths outright.
  if (!/^whsec_[A-Za-z0-9_-]{16,}$/.test(secret)) return res.status(404).json({ error: 'Not found' });

  const client = await pool.connect();
  try {
    // Find the active automation whose Webhook trigger holds this secret.
    const { rows: automations } = await client.query(
      `SELECT id, name, status, trigger_type, config FROM coexistence.chatbots WHERE status = 'active'`
    );
    let automation = null, triggerNode = null;
    for (const a of automations) {
      const t = ((a.config || {}).nodes || []).find(n => n.type === 'trigger');
      if (t && (t.triggerKind === 'webhook') && t.webhookSecret === secret) {
        automation = a; triggerNode = t; break;
      }
    }
    if (!automation) return res.status(404).json({ error: 'Not found' });

    const payload = (req.body && typeof req.body === 'object') ? req.body : {};
    const contactNumber = String(payload.contact_phone || payload.phone || '').replace(/\D/g, '');
    if (!contactNumber) {
      return res.status(400).json({ error: 'Payload must include contact_phone (E.164 or digits) so the flow knows which contact to run for.' });
    }

    // Resolve the business number the flow should send from: the trigger's
    // account filter if set, else the default/first active account.
    let waNumber = Array.isArray(triggerNode.triggerAccounts) && triggerNode.triggerAccounts[0];
    if (!waNumber) {
      const { rows: acc } = await client.query(
        `SELECT display_phone_number FROM coexistence.whatsapp_accounts
          WHERE is_active = TRUE ORDER BY is_default DESC, id LIMIT 1`
      );
      waNumber = acc[0] ? String(acc[0].display_phone_number || '').replace(/\D/g, '') : null;
    }
    if (!waNumber) return res.status(409).json({ error: 'No active WhatsApp account connected.' });

    const context = {
      contact_number: contactNumber,
      message_body: String(payload.event || ''),
      message_type: 'webhook',
      trigger_type: 'webhook',
      trigger_data: { wa_number: waNumber, contact_number: contactNumber, payload },
      webhook_payload: payload,
    };
    try {
      const { rows: c } = await client.query(
        `SELECT name, profile_name, tags, custom_fields FROM coexistence.contacts
          WHERE wa_number = $1 AND contact_number = $2 LIMIT 1`,
        [waNumber, contactNumber]
      );
      if (c.length) context.contact = { ...c[0], contact_number: contactNumber, tags: c[0].tags || [], custom_fields: c[0].custom_fields || {} };
    } catch { /* run without contact context */ }
    try {
      const { rows: fd } = await client.query(`SELECT id, name FROM coexistence.contact_field_definitions`);
      context.field_defs = fd;
    } catch { context.field_defs = []; }

    const execution = await executeAutomation(client, automation, context);
    res.json({ ok: true, executionId: execution?.id ?? null });
  } catch (err) {
    console.error('[hooks] automation webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  } finally {
    client.release();
  }
});

module.exports = { publicRouter };
