/**
 * config.routes.js — App configuration endpoints.
 *
 * GET  /api/config/:key   — fetch config (users / admin_options / nav_access / any key)
 * PUT  /api/config/:key   — save config
 *
 * Key behaviour:
 *  - "users"         → dedicated users table (passwords encrypted at rest)
 *  - "admin_options" → app_config JSON blob + clients table + dynamic owner lists from users
 *  - "nav_access"    → app_config, merges missing DB keys on save
 *  - anything else   → app_config generic JSON blob
 */

import { Router } from 'express';
import pool from '../config/db.js';
import { encrypt, decrypt } from '../config/crypto.js';

export const configRouter = Router();

const ROLE_TO_OWNER_KEY = {
  seo:     'seoOwners',
  content: 'contentOwners',
  web:     'webOwners',
  ads:     'adsOwners',
  design:  'designOwners',
  social:  'socialOwners',
  webdev:  'webdevOwners',
};

// ── GET /api/config/:key ──────────────────────────────────────────────────
configRouter.get('/:key', async (req, res) => {
  const key = req.params.key;
  try {
    // ── users ──────────────────────────────────────────────────────────────
    if (key === 'users') {
      const [rows] = await pool.query(
        'SELECT id, name, password, role, ownerName FROM users ORDER BY created_at'
      );
      const decryptedRows = rows.map(u => ({ ...u, password: decrypt(u.password) }));
      console.log(`GET /api/config/users: ${decryptedRows.length} users from users table`);
      return res.json(decryptedRows);
    }

    // ── admin_options ──────────────────────────────────────────────────────
    if (key === 'admin_options') {
      const [cfgRows] = await pool.query(
        'SELECT value FROM app_config WHERE `key` = ?', ['admin_options']
      );
      let config = {};
      if (cfgRows.length > 0) {
        const val = cfgRows[0].value;
        config = typeof val === 'string' ? JSON.parse(val) : val;
      }

      // Clients always from dedicated clients table
      const [clientRows] = await pool.query(
        'SELECT name FROM clients ORDER BY sort_order, name'
      );
      config.clients = clientRows.map(r => r.name);

      // Dynamic owner lists from users table (excludes admin)
      const [userRows] = await pool.query(
        'SELECT name, role FROM users WHERE role NOT IN (?, ?) ORDER BY name',
        ['admin', '']
      );
      Object.values(ROLE_TO_OWNER_KEY).forEach(k => { config[k] = []; });
      userRows.forEach(u => {
        const ownerKey = ROLE_TO_OWNER_KEY[u.role];
        if (ownerKey) config[ownerKey].push(u.name);
      });

      console.log(
        `GET /api/config/admin_options: ${config.clients.length} clients, ${userRows.length} users`
      );
      return res.json(config);
    }

    // ── any other key → app_config ─────────────────────────────────────────
    const [rows] = await pool.query(
      'SELECT value FROM app_config WHERE `key` = ?', [key]
    );
    if (rows.length === 0) {
      console.log(`GET /api/config/${key}: no row found`);
      return res.json(null);
    }
    const val = rows[0].value;
    const parsed = typeof val === 'string' ? JSON.parse(val) : val;
    res.json(parsed);
  } catch (e) {
    console.error('GET /api/config error:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load config' });
  }
});

// ── PUT /api/config/:key ──────────────────────────────────────────────────
configRouter.put('/:key', async (req, res) => {
  const key = req.params.key;
  let body = req.body;

  try {
    // ── users ──────────────────────────────────────────────────────────────
    if (key === 'users' && Array.isArray(body)) {
      console.log(
        `PUT /api/config/users: ${body.length} users [${body.map(u => u.name).join(', ')}]`
      );

      if (body.length === 0)
        return res.json({ ok: true, message: 'No users provided, nothing changed.' });

      const incomingIds = body.map(u => u.id).filter(Boolean);
      if (incomingIds.length === 0)
        return res.status(400).json({
          error: 'No valid user IDs in payload, aborting to prevent data loss.',
        });

      let conn;
      try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const ph = incomingIds.map(() => '?').join(',');
        await conn.query(`DELETE FROM users WHERE id NOT IN (${ph})`, incomingIds);

        for (const u of body) {
          const rawPw = u.password || '';
          // If the incoming password is already an enc: string, try to decrypt it.
          // If decrypt fails (wrong key / corrupted), keep the existing DB password
          // unchanged rather than overwriting with a bad value.
          let finalEncrypted;
          if (rawPw.startsWith('enc:')) {
            const decrypted = decrypt(rawPw);
            if (decrypted === rawPw) {
              // Decrypt failed — password came from an old session. Skip updating
              // this user's password; keep whatever is already in the DB.
              await conn.query(
                `INSERT INTO users (id, name, role, ownerName) VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   name=VALUES(name), role=VALUES(role), ownerName=VALUES(ownerName)`,
                [u.id, u.name || '', u.role || 'seo', u.ownerName || '']
              );
              continue;
            }
            // Decrypted OK — re-encrypt with current key (upgrades old encryption)
            finalEncrypted = encrypt(decrypted);
          } else {
            // Plain text password — encrypt with current key
            finalEncrypted = encrypt(rawPw);
          }
          await conn.query(
            `INSERT INTO users (id, name, password, role, ownerName) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               name=VALUES(name), password=VALUES(password),
               role=VALUES(role), ownerName=VALUES(ownerName)`,
            [u.id, u.name || '', finalEncrypted, u.role || 'seo', u.ownerName || '']
          );
        }
        await conn.commit();
      } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        throw err;
      } finally {
        if (conn) conn.release();
      }
      return res.json({ ok: true, message: `${body.length} user(s) saved successfully` });
    }

    // ── admin_options ──────────────────────────────────────────────────────
    if (key === 'admin_options' && body && typeof body === 'object' && !Array.isArray(body)) {
      // Strip dynamic owner arrays — they come from users table, not JSON blob
      const dynamicOwnerKeys = [
        'seoOwners', 'contentOwners', 'webOwners',
        'adsOwners', 'designOwners', 'socialOwners', 'webdevOwners',
      ];
      body = Object.assign({}, body);
      dynamicOwnerKeys.forEach(k => delete body[k]);

      const clientsKeyPresent = 'clients' in body;
      const incomingClients = Array.isArray(body.clients)
        ? body.clients.filter(c => c && typeof c === 'string')
        : [];
      delete body.clients; // stored in dedicated clients table

      if (clientsKeyPresent) {
        if (incomingClients.length === 0) {
          console.warn(
            'PUT /api/config/admin_options: clients key sent but empty — skipping clients table to prevent data loss'
          );
        } else {
          let conn;
          try {
            conn = await pool.getConnection();
            await conn.beginTransaction();

            const [existingRows] = await conn.query('SELECT name FROM clients');
            const existingSet = new Set(existingRows.map(r => r.name));
            const incomingSet = new Set(incomingClients);

            const toDelete = [...existingSet].filter(c => !incomingSet.has(c));
            if (toDelete.length > 0) {
              const delPh = toDelete.map(() => '?').join(',');
              await conn.query(`DELETE FROM clients WHERE name IN (${delPh})`, toDelete);
            }

            for (let i = 0; i < incomingClients.length; i++) {
              await conn.query(
                `INSERT INTO clients (name, sort_order) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)`,
                [incomingClients[i], i]
              );
            }
            await conn.commit();
            console.log(
              `PUT /api/config/admin_options: saved ${incomingClients.length} clients ` +
              `(removed ${toDelete.length})`
            );
          } catch (err) {
            if (conn) await conn.rollback().catch(() => {});
            throw err;
          } finally {
            if (conn) conn.release();
          }
        }
      } else {
        console.log(
          'PUT /api/config/admin_options: clients key absent — clients table unchanged'
        );
      }

      console.log(
        `PUT /api/config/admin_options: saving ${Object.keys(body).length} static keys`
      );
    }

    // ── nav_access — merge missing keys from DB ────────────────────────────
    if (key === 'nav_access' && body && typeof body === 'object' && !Array.isArray(body)) {
      const [existing] = await pool.query(
        'SELECT value FROM app_config WHERE `key` = ?', ['nav_access']
      );
      if (existing.length > 0) {
        let dbNav = existing[0].value;
        if (typeof dbNav === 'string') dbNav = JSON.parse(dbNav);
        if (dbNav && typeof dbNav === 'object') {
          let merged = false;
          for (const k of Object.keys(dbNav)) {
            if (!(k in body)) { body[k] = dbNav[k]; merged = true; }
          }
          if (merged) console.log('PUT /api/config/nav_access: merged missing keys from DB');
        }
      }
      console.log(`PUT /api/config/nav_access: ${Object.keys(body).length} keys`);
    } else if (key !== 'admin_options' && key !== 'users') {
      console.log(`PUT /api/config/${key}: ${JSON.stringify(body).length} bytes`);
    }

    // ── generic upsert to app_config ───────────────────────────────────────
    const value = JSON.stringify(body);
    await pool.query(
      'INSERT INTO app_config (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?',
      [key, value, value]
    );
    res.json({ ok: true, message: `Config '${key}' saved successfully` });
  } catch (e) {
    console.error('PUT /api/config error:', e.message);
    res.status(500).json({ error: 'Failed to save config' });
  }
});
