/**
 * response.js — Standard response middleware
 *
 * Attaches res.ok() and res.fail() helpers to every response so every
 * route emits the same shape:
 *
 *   Success: { ok: true, data, message }
 *   Error:   { ok: false, error: { code, message, details? } }
 *
 * Usage in controllers:
 *   return res.ok(tasks, `${tasks.length} tasks loaded`);
 *   return res.fail('VALIDATION_ERROR', 'Task ID required');
 *   return res.fail('NOT_FOUND', `Task ${id} not found`, 404);
 */

// Standard error codes — keep this list stable so the frontend can match on them
export const ErrorCodes = {
  VALIDATION_ERROR: { code: 'VALIDATION_ERROR', status: 400 },
  UNAUTHORIZED:     { code: 'UNAUTHORIZED',     status: 401 },
  FORBIDDEN:        { code: 'FORBIDDEN',        status: 403 },
  NOT_FOUND:        { code: 'NOT_FOUND',        status: 404 },
  CONFLICT:         { code: 'CONFLICT',         status: 409 },
  DB_ERROR:         { code: 'DB_ERROR',         status: 500 },
  INTERNAL_ERROR:   { code: 'INTERNAL_ERROR',   status: 500 },
};

export function attachResponders(_req, res, next) {
  /**
   * Success response.
   * @param {*} data - payload (array, object, or null)
   * @param {string} message - short human-readable message
   */
  res.ok = (data = null, message = 'OK') => {
    return res.json({ ok: true, data, message });
  };

  /**
   * Error response.
   * @param {string} code - stable machine code, ideally from ErrorCodes
   * @param {string} message - human-readable message
   * @param {number} [status] - HTTP status; inferred from code when omitted
   * @param {object} [details] - optional extra context (e.g. validation details)
   */
  res.fail = (code, message, status, details) => {
    const inferredStatus =
      typeof status === 'number'
        ? status
        : (ErrorCodes[code]?.status || 500);
    const payload = {
      ok: false,
      error: {
        code: code || 'INTERNAL_ERROR',
        message: message || 'An error occurred',
      },
    };
    if (details && typeof details === 'object') {
      payload.error.details = details;
    }
    return res.status(inferredStatus).json(payload);
  };

  next();
}
