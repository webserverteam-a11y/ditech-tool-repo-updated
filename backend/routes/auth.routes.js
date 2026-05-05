/**
 * auth.routes.js — Login endpoint.
 *
 * POST /api/login
 */

import { Router } from 'express';
import pool from '../config/db.js';
import { decrypt } from '../config/crypto.js';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password)
    return res.status(400).json({ error: 'name and password are required' });

  try {
    const [rows] = await pool.query(
      'SELECT id, name, password, role, ownerName FROM users WHERE LOWER(name) = LOWER(?) LIMIT 1',
      [name]
    );

    if (rows.length === 0)
      return res.status(401).json({ error: 'Invalid credentials' });

    const storedPassword = decrypt(rows[0].password);
    if (storedPassword !== password)
      return res.status(401).json({ error: 'Invalid credentials' });

    const { password: _, ...safe } = rows[0];
    res.json({ ok: true, message: `Welcome back, ${safe.name}!`, user: safe });
  } catch (e) {
    console.error('POST /api/login error:', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});
