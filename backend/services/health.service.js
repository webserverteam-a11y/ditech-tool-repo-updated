/**
 * health.service.js — Business logic for /api/health.
 *
 * Pure functions: no req/res. Returns plain data objects that the
 * controller wraps with res.ok / res.fail.
 */

import pool from '../config/db.js';
import { EXPECTED_TABLES, ensureTables } from '../db/init.js';

/**
 * Gather a full health snapshot: pool stats, DB reachability, and which
 * tables exist. Never throws — returns a result object that includes any
 * error it hit.
 */
export async function getHealthSnapshot() {
  const result = {
    server: true,
    db: false,
    tables: {},
    error: null,
    env: {
      DB_HOST: process.env.DB_HOST ? '***set***' : 'MISSING',
      DB_USER: process.env.DB_USER ? '***set***' : 'MISSING',
      DB_PASS: process.env.DB_PASS ? '***set***' : 'MISSING',
      DB_NAME: process.env.DB_NAME || 'MISSING',
      DB_PORT: process.env.DB_PORT || '3306 (default)',
    },
    pool: { total: 0, free: 0, queued: 0 },
  };

  try {
    const p = pool.pool;
    result.pool.total = p._allConnections?.length ?? -1;
    result.pool.free = p._freeConnections?.length ?? -1;
    result.pool.queued = p._connectionQueue?.length ?? -1;
  } catch (_) {
    /* pool internals are best-effort */
  }

  try {
    const [testRows] = await pool.query('SELECT 1 as ok');
    result.db = testRows && testRows[0] && testRows[0].ok === 1;
    const [tables] = await pool.query('SHOW TABLES');
    const tableNames = tables.map((t) => Object.values(t)[0]);
    for (const name of EXPECTED_TABLES) {
      result.tables[name] = tableNames.includes(name);
    }
  } catch (e) {
    result.error = `${e.code || 'UNKNOWN'}: ${e.message}`;
  }

  return result;
}

/**
 * Force-create all expected tables. Returns a per-table status map.
 */
export async function forceDbInit() {
  const tables = await ensureTables(pool);
  return { tables };
}
