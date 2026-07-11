// Tasks (migration 069): created by the Human Handoff "Create Task" notify or
// manually. Admins see the tenant's tasks; sales users see their own.

const { Router } = require('express');
const pool = require('../db');
const { isAdmin, scopeClause, auditLog } = require('../middleware/access');

const router = Router();

function shape(r) {
  return {
    id: r.id, title: r.title, description: r.description,
    status: r.status, priority: r.priority, dueAt: r.due_at,
    assignedUserId: r.assigned_user_id, assigneeName: r.assignee_name || null,
    waNumber: r.wa_number, contactNumber: r.contact_number,
    source: r.source, createdAt: r.created_at, completedAt: r.completed_at,
  };
}

// GET /tasks?status=open — admins: all tenant tasks; others: their own.
router.get('/tasks', async (req, res) => {
  try {
    const params = [];
    let where = scopeClause(req, 't', params, { leading: 'WHERE ' }) || 'WHERE TRUE';
    if (req.query.status && ['open', 'done', 'cancelled'].includes(req.query.status)) {
      params.push(req.query.status);
      where += ` AND t.status = $${params.length}`;
    }
    if (!isAdmin(req.user)) {
      // Non-admins see their own tasks plus unassigned ones (anyone can pick those up).
      params.push(req.user.id);
      where += ` AND (t.assigned_user_id = $${params.length} OR t.assigned_user_id IS NULL)`;
    }
    const { rows } = await pool.query(
      `SELECT t.*, u.display_name AS assignee_name
         FROM coexistence.tasks t
         LEFT JOIN coexistence.z_chat_users u ON u.id = t.assigned_user_id
         ${where}
        ORDER BY (t.status = 'open') DESC, t.due_at NULLS LAST, t.created_at DESC
        LIMIT 200`,
      params
    );
    res.json(rows.map(shape));
  } catch (err) {
    console.error('[tasks] list error:', err.message);
    res.status(500).json({ error: 'Failed to list tasks' });
  }
});

// POST /tasks — manual creation.
router.post('/tasks', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title is required' });
    const { rows } = await pool.query(
      `INSERT INTO coexistence.tasks
         (title, description, priority, due_at, assigned_user_id, wa_number, contact_number, source, created_by, tenant_id, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,$10) RETURNING *`,
      [
        String(b.title).trim().slice(0, 300), b.description || null,
        ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'normal',
        b.dueAt || null,
        b.assignedUserId ? parseInt(b.assignedUserId, 10) : req.user.id,
        b.waNumber || null, b.contactNumber || null,
        req.user.id, req.tenantId ?? null, req.organizationId ?? null,
      ]
    );
    res.status(201).json(shape(rows[0]));
  } catch (err) {
    console.error('[tasks] create error:', err.message);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// PATCH /tasks/:id — status / assignee / due date.
router.patch('/tasks/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const sets = ['updated_at = NOW()'];
    const params = [];
    let i = 1;
    if (b.status && ['open', 'done', 'cancelled'].includes(b.status)) {
      sets.push(`status = $${i++}`); params.push(b.status);
      sets.push(`completed_at = ${b.status === 'done' ? 'NOW()' : 'NULL'}`);
    }
    if (b.assignedUserId !== undefined) { sets.push(`assigned_user_id = $${i++}`); params.push(b.assignedUserId ? parseInt(b.assignedUserId, 10) : null); }
    if (b.dueAt !== undefined) { sets.push(`due_at = $${i++}`); params.push(b.dueAt || null); }
    if (b.title !== undefined) { sets.push(`title = $${i++}`); params.push(String(b.title).trim().slice(0, 300)); }
    if (params.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    let guard = `WHERE id = $${i++}`;
    if (req.tenantId != null) { params.push(req.tenantId); guard += ` AND tenant_id = $${i++}`; }
    if (!isAdmin(req.user)) { params.push(req.user.id); guard += ` AND assigned_user_id = $${i++}`; }
    const { rows } = await pool.query(
      `UPDATE coexistence.tasks SET ${sets.join(', ')} ${guard} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Task not found' });
    res.json(shape(rows[0]));
  } catch (err) {
    console.error('[tasks] update error:', err.message);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// DELETE /tasks/:id — admin only.
router.delete('/tasks/:id', async (req, res) => {
  try {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin access required' });
    const params = [req.params.id];
    let guard = 'WHERE id = $1';
    if (req.tenantId != null) { params.push(req.tenantId); guard += ' AND tenant_id = $2'; }
    const { rowCount } = await pool.query(`DELETE FROM coexistence.tasks ${guard}`, params);
    if (!rowCount) return res.status(404).json({ error: 'Task not found' });
    await auditLog({ actor: req.user, action: 'task.delete', targetType: 'task', targetId: req.params.id, from: req });
    res.json({ ok: true });
  } catch (err) {
    console.error('[tasks] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

module.exports = { router };
