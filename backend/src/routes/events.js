// Server-Sent Events stream for real-time push to the chat UI. The frontend
// opens one connection per tab via `new EventSource('/api/events')`; the auth
// cookie rides along and `authMiddleware` upstream verifies the JWT before we
// get here. nginx already disables proxy buffering for this exact location
// (frontend/nginx.conf) so events flush immediately.
//
// Events emitted:
//   - 'message-status': { waNumber, contactNumber, messageId, status }
//       Pushed when a Meta delivery/read receipt advances an outbound message's
//       status, so the chat tick turns blue without waiting for the poll.
//   - 'message-new': { waNumber, contactNumber }
//       Pushed when a new message row is created for a conversation (an inbound
//       customer message, or any outbound send: manual, agent, automation,
//       broadcast). Open chat windows + the contact list refetch instantly
//       instead of waiting for the next poll.

const { Router } = require('express');
const bus = require('../events');
const pool = require('../db');

const router = Router();

// Every event the stream forwards. Kept as a list so adding a new push event is
// a one-liner here + a bus.emit() at the source.
const FORWARDED_EVENTS = [
  'message-status', 'message-new',
  // Live CRM/agent state so chat headers, contact lists and the composer update
  // without a manual reload.
  'contact-saved', 'contact-assignment-changed', 'agent-handoff', 'agent-resumed',
];

router.get('/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Initial handshake — also nudges proxies that wait for the first byte.
  res.write(`event: hello\ndata: {"ts":${Date.now()},"userId":${req.user?.id ?? null}}\n\n`);

  // Tenant isolation: the event bus is process-global, so only forward events
  // for THIS tenant's WhatsApp numbers. Resolve them once at connect time. A
  // null tenant (legacy single-tenant install / super admin) is unfiltered; a
  // lookup failure falls back to unfiltered so a transient DB hiccup never
  // silently freezes the live chat (it self-heals on reconnect / the 15s poll).
  let waSet = null;
  if (req.tenantId != null) {
    try {
      const { rows } = await pool.query(
        `SELECT display_phone_number FROM coexistence.whatsapp_accounts WHERE tenant_id = $1`,
        [req.tenantId]
      );
      waSet = new Set(rows.map(r => String(r.display_phone_number || '').replace(/\D/g, '')).filter(Boolean));
    } catch (err) {
      console.error('[events] wa-number scope lookup failed (streaming unfiltered):', err.message);
      waSet = null;
    }
  }
  const allowed = (payload) => {
    if (waSet == null) return true; // no tenant context → unfiltered (legacy)
    const wa = String(payload?.waNumber || '').replace(/\D/g, '');
    return wa !== '' && waSet.has(wa);
  };

  const writeEvent = (event, data) => {
    if (res.writableEnded) return;
    if (!allowed(data)) return; // not this tenant's conversation — skip
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Connection may have died mid-write; the close handler cleans up.
    }
  };

  const handlers = {};
  for (const event of FORWARDED_EVENTS) {
    handlers[event] = (payload) => writeEvent(event, payload);
    bus.on(event, handlers[event]);
  }

  // Keepalive every 25s — most proxies idle-close at 30-60s.
  const keepalive = setInterval(() => {
    if (res.writableEnded) return;
    try { res.write(': ka\n\n'); } catch { /* connection died */ }
  }, 25000);

  const cleanup = () => {
    clearInterval(keepalive);
    for (const event of FORWARDED_EVENTS) bus.off(event, handlers[event]);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

module.exports = { router };
