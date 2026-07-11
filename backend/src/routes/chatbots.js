const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requirePermission, scopeClause, orgScope } = require('../middleware/access');


const VALID_NODE_TYPES = new Set([
  'trigger', 'message', 'condition', 'delay', 'action',
  'handoff', 'ai', 'api', 'subflow',
]);
function sanitizeConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const rawNodes = Array.isArray(config.nodes) ? config.nodes : [];
  const rawEdges = Array.isArray(config.edges) ? config.edges : [];

  const seen = new Set();
  const nodes = [];
  let triggerSeen = false;
  for (const n of rawNodes) {
    if (!n || typeof n !== 'object' || n.id == null) continue;
    if (!VALID_NODE_TYPES.has(n.type)) continue;
    if (seen.has(n.id)) continue;
    if (n.type === 'trigger') {
      if (triggerSeen) continue; // one trigger max — first wins
      triggerSeen = true;
    }
    seen.add(n.id);
    nodes.push(n);
  }

  const edgeKeys = new Set();
  const edges = rawEdges.filter(e => {
    if (!e || typeof e !== 'object' || !seen.has(e.from) || !seen.has(e.to) || e.from === e.to) return false;
    const key = `${e.from}|${e.to}|${e.fromHandle || 'default'}`;
    if (edgeKeys.has(key)) return false; // duplicate edge
    edgeKeys.add(key);
    return true;
  });

  return { ...config, nodes, edges };
}

// GET /chatbots — list all
router.get('/chatbots', async (req, res) => {
  try {
    const params = [];
    const where = scopeClause(req, null, params, { leading: 'WHERE ' }) + orgScope(req, null, params);
    const { rows } = await pool.query(
      `SELECT id, name, description, status, trigger_type, config, created_at, updated_at
       FROM coexistence.chatbots
       ${where}
       ORDER BY updated_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('[chatbots] list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch chatbots' });
  }
});

// GET /chatbots/:id — single chatbot
router.get('/chatbots/:id', async (req, res) => {
  try {
    const idParams = [req.params.id];
    const { rows } = await pool.query(
      `SELECT id, name, description, status, trigger_type, config, created_at, updated_at
       FROM coexistence.chatbots WHERE id = $1${scopeClause(req, null, idParams)}`,
      idParams
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[chatbots] get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch chatbot' });
  }
});

// POST /chatbots — create
router.post('/chatbots', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const { name, description, status, trigger_type, config } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, tenant_id, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [name.trim(), description || null, status || 'draft', trigger_type || 'keyword', JSON.stringify(sanitizeConfig(config) || {}), req.tenantId ?? null, req.organizationId ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[chatbots] create error:', err.message);
    res.status(500).json({ error: 'Failed to create chatbot' });
  }
});

// PUT /chatbots/:id — update
router.put('/chatbots/:id', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const { name, description, status, trigger_type, config } = req.body;
    if (name !== undefined && !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const updParams = [name ? name.trim() : null, description, status, trigger_type, config ? JSON.stringify(sanitizeConfig(config)) : null, req.params.id];
    const { rows } = await pool.query(
      `UPDATE coexistence.chatbots SET
        name = COALESCE($1, name),
        description = $2,
        status = COALESCE($3, status),
        trigger_type = COALESCE($4, trigger_type),
        config = COALESCE($5, config),
        updated_at = NOW()
       WHERE id = $6${scopeClause(req, null, updParams)}
       RETURNING *`,
      updParams
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[chatbots] update error:', err.message);
    res.status(500).json({ error: 'Failed to update chatbot' });
  }
});

// POST /chatbots/:id/duplicate — clone an automation. The copy is always
// created DISABLED ('inactive') so it can't fire until reviewed/enabled.
router.post('/chatbots/:id/duplicate', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const srcParams = [req.params.id];
    const { rows: src } = await pool.query(
      `SELECT name, description, trigger_type, config FROM coexistence.chatbots WHERE id = $1${scopeClause(req, null, srcParams)}`,
      srcParams
    );
    if (src.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
    const c = src[0];
    const { rows } = await pool.query(
      `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, tenant_id, organization_id)
       VALUES ($1,$2,'inactive',$3,$4,$5,$6)
       RETURNING id, name, description, status, trigger_type, config, created_at, updated_at`,
      [`${c.name} (copy)`, c.description, c.trigger_type, JSON.stringify(c.config || {}), req.tenantId ?? null, req.organizationId ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[chatbots] duplicate error:', err.message);
    res.status(500).json({ error: 'Failed to duplicate chatbot' });
  }
});

// GET /chatbots/:id/export — portable automation file (id/timestamps stripped).
router.get('/chatbots/:id/export', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const expParams = [req.params.id];
    const { rows } = await pool.query(
      `SELECT name, description, trigger_type, config FROM coexistence.chatbots WHERE id = $1${scopeClause(req, null, expParams)}`,
      expParams
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Chatbot not found' });
    const c = rows[0];
    res.json({
      type: 'z-chat.automation',
      version: 1,
      automation: { name: c.name, description: c.description, trigger_type: c.trigger_type, config: c.config || {} },
    });
  } catch (err) {
    console.error('[chatbots] export error:', err.message);
    res.status(500).json({ error: 'Failed to export chatbot' });
  }
});

// POST /chatbots/import — create a new automation from an export file. Always
// lands DISABLED ('inactive') so it can't fire until reviewed/enabled.
router.post('/chatbots/import', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const payload = req.body || {};
    if (payload.type !== 'z-chat.automation' || !payload.automation || !payload.automation.name) {
      return res.status(400).json({ error: 'That file is not a Zen Chat automation export.' });
    }
    const a = payload.automation;
    const { rows } = await pool.query(
      `INSERT INTO coexistence.chatbots (name, description, status, trigger_type, config, tenant_id, organization_id)
       VALUES ($1,$2,'inactive',$3,$4,$5,$6)
       RETURNING id, name, description, status, trigger_type, config, created_at, updated_at`,
      [`${String(a.name).trim()} (imported)`.slice(0, 200), a.description || null, a.trigger_type || 'keyword', JSON.stringify(sanitizeConfig(a.config) || {}), req.tenantId ?? null, req.organizationId ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[chatbots] import error:', err.message);
    res.status(500).json({ error: 'Failed to import chatbot' });
  }
});

// DELETE /chatbots/:id
router.delete('/chatbots/:id', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const delParams = [req.params.id];
    const { rowCount } = await pool.query(
      `DELETE FROM coexistence.chatbots WHERE id = $1${scopeClause(req, null, delParams)}`, delParams
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Chatbot not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[chatbots] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete chatbot' });
  }
});

// GET /chatbots/:id/executions — paginated list of executions for an automation
router.get('/chatbots/:id/executions', async (req, res) => {
  try {
    const automationId = req.params.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    // Filters
    const statusFilter = req.query.status;
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const messageStatus = req.query.messageStatus;

    let whereClause = 'WHERE e.automation_id = $1';
    const params = [automationId];
    let paramIdx = 2;

    if (statusFilter && statusFilter !== 'all') {
      whereClause += ` AND e.status = $${paramIdx}`;
      params.push(statusFilter);
      paramIdx++;
    }

    if (startDate) {
      whereClause += ` AND e.started_at >= $${paramIdx}`;
      params.push(new Date(startDate).toISOString());
      paramIdx++;
    }

    if (endDate) {
      whereClause += ` AND e.started_at <= $${paramIdx}`;
      params.push(new Date(endDate).toISOString());
      paramIdx++;
    }

    // Message status filter — find executions where any step has the given wa_message_status
    let joinClause = '';
    if (messageStatus && messageStatus !== 'all') {
      joinClause = `JOIN coexistence.automation_execution_steps s ON s.execution_id = e.id AND s.wa_message_status = $${paramIdx}`;
      params.push(messageStatus);
      paramIdx++;
    }

    // Tenant scope (Phase 2 residual).
    if (req.tenantId != null) {
      whereClause += ` AND e.tenant_id = $${paramIdx}`;
      params.push(req.tenantId);
      paramIdx++;
    }

    const countQuery = messageStatus && messageStatus !== 'all'
      ? `SELECT COUNT(DISTINCT e.id) FROM coexistence.automation_executions e ${joinClause} ${whereClause}`
      : `SELECT COUNT(*) FROM coexistence.automation_executions e ${whereClause}`;

    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count, 10);

    const dataQuery = messageStatus && messageStatus !== 'all'
      ? `SELECT DISTINCT e.id, e.automation_id, e.status, e.trigger_type, e.trigger_data, e.contact_number,
              e.started_at, e.completed_at, e.error_message, e.created_at
       FROM coexistence.automation_executions e
       ${joinClause}
       ${whereClause}
       ORDER BY e.started_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`
      : `SELECT e.id, e.automation_id, e.status, e.trigger_type, e.trigger_data, e.contact_number,
              e.started_at, e.completed_at, e.error_message, e.created_at
       FROM coexistence.automation_executions e
       ${whereClause}
       ORDER BY e.started_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;

    const { rows } = await pool.query(dataQuery, [...params, limit, offset]);

    res.json({
      executions: rows,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[chatbots] GET /chatbots/:id/executions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch executions' });
  }
});

// GET /executions/:id — single execution with all steps
router.get('/executions/:id', async (req, res) => {
  try {
    const execParams = [req.params.id];
    const { rows: execRows } = await pool.query(
      `SELECT id, automation_id, status, trigger_type, trigger_data, contact_number,
              started_at, completed_at, error_message, created_at
       FROM coexistence.automation_executions
       WHERE id = $1${scopeClause(req, null, execParams)}`,
      execParams
    );
    if (execRows.length === 0) return res.status(404).json({ error: 'Execution not found' });

    const { rows: stepRows } = await pool.query(
      `SELECT id, execution_id, node_id, node_type, node_name, input_data, output_data,
              status, started_at, completed_at, error_message, wa_message_id, wa_message_status, created_at
       FROM coexistence.automation_execution_steps
       WHERE execution_id = $1
       ORDER BY started_at ASC`,
      [req.params.id]
    );

    res.json({ ...execRows[0], steps: stepRows });
  } catch (err) {
    console.error('[chatbots] GET /executions/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch execution' });
  }
});

// POST /executions/:id/cancel — stop a non-terminal execution. A cancelled
// 'paused' execution will no longer resume when the customer replies (the
// webhook resume only claims rows WHERE status='paused').
router.post('/executions/:id/cancel', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const cancelParams = [req.params.id];
    const cancelScope = scopeClause(req, null, cancelParams);
    const { rows } = await pool.query(
      `UPDATE coexistence.automation_executions
          SET status = 'cancelled',
              completed_at = NOW(),
              error_message = COALESCE(error_message, 'Cancelled by user')
        WHERE id = $1 AND status IN ('running', 'paused', 'queued')${cancelScope}
        RETURNING *`,
      cancelParams
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: 'Execution is already finished — nothing to stop.' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[chatbots] cancel execution error:', err.message);
    res.status(500).json({ error: 'Failed to cancel execution' });
  }
});

// sanitizeToLinear kept as an alias for any legacy import (same behavior now).
module.exports = { router, sanitizeConfig, sanitizeToLinear: sanitizeConfig };
