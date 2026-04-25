/**
 * health.controller.js — HTTP glue for /api/health and /api/db-init.
 *
 * All handlers follow the same shape:
 *   1. Validate input (or skip for GET routes with no input)
 *   2. Call a service function
 *   3. Return res.ok(data, message) on success
 *   4. Forward unexpected errors to next() so globalErrorHandler catches them
 */

import { getHealthSnapshot, forceDbInit } from '../services/health.service.js';

/** GET /api/health */
export async function health(_req, res, next) {
  try {
    const snapshot = await getHealthSnapshot();
    const message = snapshot.db
      ? 'Server and database are healthy'
      : 'Server up, database unreachable';
    return res.ok(snapshot, message);
  } catch (err) {
    return next(err);
  }
}

/** GET /api/db-init — force-create missing tables */
export async function dbInit(_req, res, next) {
  try {
    const data = await forceDbInit();
    const failed = Object.entries(data.tables).filter(
      ([, status]) => status !== 'OK'
    );
    const message =
      failed.length === 0
        ? `All ${Object.keys(data.tables).length} tables ensured`
        : `${failed.length} table(s) failed to create — see data.tables`;
    return res.ok(data, message);
  } catch (err) {
    return next(err);
  }
}
