/**
 * clients.routes.js — Clients CRUD.
 *
 * GET    /api/clients          — list all clients
 * POST   /api/clients          — add single client (safe, no bulk wipe)
 * DELETE /api/clients/:name    — remove single client
 * PUT    /api/clients/reorder  — update sort_order
 */

import { Router } from 'express';
import pool from '../config/db.js';

export const clientsRouter = Router();

clientsRouter.get('/', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT name FROM clients ORDER BY sort_order, name');
    res.json(rows.map(r => r.name));
  } catch (e) {
    console.error('GET /api/clients error:', e.message);
    res.status(500).json({ error: 'Failed to load clients' });
  }
});

clientsRouter.post('/', async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'Client name is required' });

  const clientName = name.trim();
  try {
    const [maxRow] = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM clients');
    const nextOrder = (maxRow[0].maxOrder ?? -1) + 1;
    await pool.query(
      'INSERT INTO clients (name, sort_order) VALUES (?, ?) ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)',
      [clientName, nextOrder]
    );
    res.json({ ok: true, message: `Client "${clientName}" added successfully` });
  } catch (e) {
    console.error('POST /api/clients error:', e.message);
    res.status(500).json({ error: 'Failed to add client' });
  }
});

clientsRouter.delete('/:name', async (req, res) => {
  const clientName = decodeURIComponent(req.params.name);
  if (!clientName) return res.status(400).json({ error: 'Client name is required' });

  try {
    const [result] = await pool.query('DELETE FROM clients WHERE name = ?', [clientName]);
    if (result.affectedRows === 0)
      return res.status(404).json({ error: `Client "${clientName}" not found` });
    res.json({ ok: true, message: `Client "${clientName}" removed successfully` });
  } catch (e) {
    console.error('DELETE /api/clients/:name error:', e.message);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

clientsRouter.put('/reorder', async (req, res) => {
  const list = req.body;
  if (!Array.isArray(list))
    return res.status(400).json({ error: 'Expected array of client names' });

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    for (let i = 0; i < list.length; i++) {
      await conn.query('UPDATE clients SET sort_order = ? WHERE name = ?', [i, list[i]]);
    }
    await conn.commit();
    res.json({ ok: true, message: `${list.length} client(s) reordered` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('PUT /api/clients/reorder error:', e.message);
    res.status(500).json({ error: 'Failed to reorder clients' });
  } finally {
    if (conn) conn.release();
  }
});
