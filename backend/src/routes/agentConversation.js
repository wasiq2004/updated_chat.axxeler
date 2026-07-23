// Per-conversation agent controls for the Chats UI: is the bot active here, and
// the manual "take over" / "return to bot" switch. BDA-accessible (gated by
// assertContactAccess), unlike the admin-only agent CRUD in routes/agents.js.

const { Router } = require('express');
const pool = require('../db');
const { assertContactAccess } = require('../middleware/access');
const { performHandoff, resumeAgent } = require('../services/agentHandoff');

const router = Router();

// Find the agent this conversation would actually talk to. Since migration 082
// several agents can be live on one number (1 'any' + 1 'new' + N keyword), so
// "the" agent is resolved in the same spirit as the router:
//   1. the conversation's explicit binding (contacts.agent_id),
//   2. else the live agent that most recently ran for THIS contact,
//   3. else the always-on 'any' agent, then 'new', then the first keyword one —
//      a deterministic pick for the header label, not a routing decision.
async function activeAgentForConversation(waNumber, contactNumber) {
  const { rows } = await pool.query(
    `SELECT a.id, a.name
       FROM coexistence.agents a
       JOIN coexistence.whatsapp_accounts w ON w.id = a.wa_account_id
       LEFT JOIN coexistence.contacts c
         ON c.wa_number = regexp_replace($1, '\\D', '', 'g') AND c.contact_number = $2
       LEFT JOIN LATERAL (
         SELECT MAX(r.started_at) AS last_run
           FROM coexistence.agent_runs r
          WHERE r.agent_id = a.id AND r.contact_number = $2
       ) runs ON TRUE
      WHERE regexp_replace(w.display_phone_number, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g')
        AND (a.is_active = TRUE OR a.id = c.agent_id)
        AND a.status <> 'draft'
      ORDER BY (a.id = c.agent_id) DESC NULLS LAST,
               runs.last_run DESC NULLS LAST,
               CASE a.trigger_mode WHEN 'any' THEN 0 WHEN 'new' THEN 1 ELSE 2 END,
               a.id
      LIMIT 1`,
    [waNumber || '', contactNumber || ''],
  );
  return rows[0] || null;
}

// GET /api/agent-conversation?waNumber=&contactNumber=
// → { hasAgent, agentId, agentName, paused, pausedBy, pausedReason, pausedAt }
router.get('/agent-conversation', async (req, res) => {
  const waNumber = String(req.query.waNumber || '');
  const contactNumber = String(req.query.contactNumber || '');
  if (!waNumber || !contactNumber) return res.status(400).json({ error: 'waNumber and contactNumber are required' });
  if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
  try {
    const agent = await activeAgentForConversation(waNumber, contactNumber);
    const { rows } = await pool.query(
      `SELECT agent_paused, agent_paused_by, agent_paused_reason, agent_paused_at
         FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2`,
      [waNumber, contactNumber],
    );
    const c = rows[0] || {};
    res.json({
      hasAgent: !!agent,
      agentId: agent?.id || null,
      agentName: agent?.name || null,
      paused: !!c.agent_paused,
      pausedBy: c.agent_paused_by || null,
      pausedReason: c.agent_paused_reason || null,
      pausedAt: c.agent_paused_at || null,
    });
  } catch (err) {
    console.error('[agent-conversation] status error:', err.message);
    res.status(500).json({ error: 'Failed to load agent status' });
  }
});

// POST /api/agent-conversation/pause  { waNumber, contactNumber }  — take over.
router.post('/agent-conversation/pause', async (req, res) => {
  const { waNumber, contactNumber } = req.body || {};
  if (!waNumber || !contactNumber) return res.status(400).json({ error: 'waNumber and contactNumber are required' });
  if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
  try {
    const agent = await activeAgentForConversation(waNumber, contactNumber);
    if (!agent) return res.status(400).json({ error: 'No active AI agent on this number.' });
    const who = req.user?.displayName || req.user?.username || `user ${req.user?.id}`;
    const r = await performHandoff({
      agentId: agent.id, handoffUserIds: [], waNumber, contactNumber,
      reason: `Taken over by ${who}`, by: `manual:${req.user?.id}`, assignTo: req.user?.id,
    });
    res.json({ ok: true, paused: true, assignedUserId: r.assignedUserId, assignedUserName: r.assignedUserName });
  } catch (err) {
    console.error('[agent-conversation] pause error:', err.message);
    res.status(500).json({ error: 'Failed to take over the conversation' });
  }
});

// POST /api/agent-conversation/resume  { waNumber, contactNumber }  — return to bot.
router.post('/agent-conversation/resume', async (req, res) => {
  const { waNumber, contactNumber } = req.body || {};
  if (!waNumber || !contactNumber) return res.status(400).json({ error: 'waNumber and contactNumber are required' });
  if (!(await assertContactAccess(req, res, waNumber, contactNumber))) return;
  try {
    await resumeAgent({ waNumber, contactNumber, by: `manual:${req.user?.id}` });
    res.json({ ok: true, paused: false });
  } catch (err) {
    console.error('[agent-conversation] resume error:', err.message);
    res.status(500).json({ error: 'Failed to return the conversation to the bot' });
  }
});

module.exports = { router };
