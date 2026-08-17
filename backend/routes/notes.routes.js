/**
 * notes.routes.js — Sticky Notes panel CRUD.
 *
 * A brand-new, standalone feature: the floating Sticky Notes panel injected
 * into dist/index.html (see the "_dt-notes" script block near the end of
 * that file). Reads/writes only its own `sticky_notes` table — never
 * touches tasks, users, or any other route.
 *
 * Notes are private per-user, scoped by `user_name` (the same display-name
 * string the rest of the app uses as an identity key, e.g. leave_records /
 * workhub_remarks) — every request must pass `user`.
 *
 * GET    /api/notes?user=<name>   — list this user's notes, most-recently-updated first
 * POST   /api/notes               — create a note { user, content }
 * PUT    /api/notes/:id           — update a note's content { content }
 * DELETE /api/notes/:id           — delete a note
 */

import { Router } from 'express';
import pool from '../config/db.js';

export const notesRouter = Router();

function toNote(r) {
  return { id: r.id, content: r.content, createdAt: r.created_at, updatedAt: r.updated_at };
}

notesRouter.get('/', async (req, res) => {
  const user = (req.query.user || '').trim();
  if (!user) return res.status(400).json({ error: 'user param required' });

  try {
    const [rows] = await pool.query(
      `SELECT id, content, created_at, updated_at FROM sticky_notes
       WHERE user_name = ? ORDER BY updated_at DESC`,
      [user]
    );
    res.json(rows.map(toNote));
  } catch (e) {
    console.error('GET /api/notes error:', e.message);
    res.status(500).json({ error: 'Failed to load notes' });
  }
});

notesRouter.post('/', async (req, res) => {
  const b = req.body || {};
  const user = (b.user || '').trim();
  const content = (b.content || '').trim();
  if (!user) return res.status(400).json({ error: 'user is required' });
  if (!content) return res.status(400).json({ error: 'content is required' });

  const id = 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  try {
    await pool.query(
      `INSERT INTO sticky_notes (id, user_name, content) VALUES (?, ?, ?)`,
      [id, user, content]
    );
    const [[row]] = await pool.query(
      `SELECT id, content, created_at, updated_at FROM sticky_notes WHERE id = ?`, [id]
    );
    res.status(201).json(toNote(row));
  } catch (e) {
    console.error('POST /api/notes error:', e.message);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

notesRouter.put('/:id', async (req, res) => {
  const { id } = req.params;
  const content = ((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: 'content is required' });

  try {
    const [result] = await pool.query(
      `UPDATE sticky_notes SET content = ? WHERE id = ?`, [content, id]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ error: `Note "${id}" not found` });

    const [[row]] = await pool.query(
      `SELECT id, content, created_at, updated_at FROM sticky_notes WHERE id = ?`, [id]
    );
    res.json(toNote(row));
  } catch (e) {
    console.error('PUT /api/notes/:id error:', e.message);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

notesRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query('DELETE FROM sticky_notes WHERE id = ?', [id]);
    if (result.affectedRows === 0)
      return res.status(404).json({ error: `Note "${id}" not found` });

    res.json({ ok: true, message: 'Note deleted' });
  } catch (e) {
    console.error('DELETE /api/notes/:id error:', e.message);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});
