// Follow-up sequences CRUD (migration 070) + enrollment stats. The drip itself
// is driven by services/sequences.js (Start/Pause/End automation actions + the
// 60s sweeper started in index.js).

const { Router } = require('express');
const pool = require('../db');
const { requirePermission, scopeClause } = require('../middleware/access');

const router = Router();

function shape(r) {
  return {
    id: r.id, name: r.name, description: r.description, isActive: r.is_active,
    steps: Array.isArray(r.steps) ? r.steps : [],
    active: r.active_count ?? 0, completed: r.completed_count ?? 0,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function cleanSteps(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(s => ({
      templateId: parseInt(s?.templateId, 10) || null,
      delayValue: Math.max(0, Math.min(10000, parseInt(s?.delayValue ?? 0, 10) || 0)),
      delayUnit: ['minutes', 'hours', 'days'].includes(s?.delayUnit) ? s.delayUnit : 'hours',
    }))
    .filter(s => s.templateId)
    .slice(0, 20);
}

router.get('/sequences', async (req, res) => {
  try {
    const params = [];
    const where = scopeClause(req, 's', params, { leading: 'WHERE ' }) || '';
    const { rows } = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(*)::int FROM coexistence.sequence_enrollments e WHERE e.sequence_id = s.id AND e.status = 'active') AS active_count,
              (SELECT COUNT(*)::int FROM coexistence.sequence_enrollments e WHERE e.sequence_id = s.id AND e.status = 'completed') AS completed_count
         FROM coexistence.sequences s ${where}
        ORDER BY s.updated_at DESC`,
      params
    );
    res.json(rows.map(shape));
  } catch (err) {
    console.error('[sequences] list error:', err.message);
    res.status(500).json({ error: 'Failed to list sequences' });
  }
});

router.post('/sequences', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO coexistence.sequences (name, description, is_active, steps, tenant_id, organization_id, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`,
      [
        String(b.name).trim().slice(0, 200), b.description || null,
        b.isActive !== false, JSON.stringify(cleanSteps(b.steps)),
        req.tenantId ?? null, req.organizationId ?? null, req.user.id,
      ]
    );
    res.status(201).json(shape(rows[0]));
  } catch (err) {
    console.error('[sequences] create error:', err.message);
    res.status(500).json({ error: 'Failed to create sequence' });
  }
});

router.put('/sequences/:id', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const b = req.body || {};
    const params = [
      b.name != null ? String(b.name).trim().slice(0, 200) : null,
      b.description !== undefined,                       // description provided?
      b.description !== undefined ? (b.description || null) : null,
      b.isActive !== undefined ? !!b.isActive : null,
      b.steps !== undefined ? JSON.stringify(cleanSteps(b.steps)) : null,
      req.params.id,
    ];
    const guard = scopeClause(req, null, params);
    const { rows } = await pool.query(
      `UPDATE coexistence.sequences SET
         name = COALESCE($1, name),
         description = CASE WHEN $2::boolean THEN $3 ELSE description END,
         is_active = COALESCE($4, is_active),
         steps = COALESCE($5::jsonb, steps),
         updated_at = NOW()
       WHERE id = $6${guard} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Sequence not found' });
    res.json(shape(rows[0]));
  } catch (err) {
    console.error('[sequences] update error:', err.message);
    res.status(500).json({ error: 'Failed to update sequence' });
  }
});

router.delete('/sequences/:id', requirePermission('chatbot-builder'), async (req, res) => {
  try {
    const params = [req.params.id];
    const guard = scopeClause(req, null, params);
    const { rowCount } = await pool.query(`DELETE FROM coexistence.sequences WHERE id = $1${guard}`, params);
    if (!rowCount) return res.status(404).json({ error: 'Sequence not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[sequences] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete sequence' });
  }
});

module.exports = { router };
