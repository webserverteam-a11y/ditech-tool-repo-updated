/**
 * errorHandler.js — Global error handler (last middleware in chain)
 *
 * Catches any error thrown in a route/controller and converts it into the
 * standard failure response shape. Controllers should call next(err) on
 * unexpected errors; this middleware takes care of logging and status mapping.
 *
 * It also installs a 404 handler for /api/* routes that don't match.
 */

import { ErrorCodes } from './response.js';

export function apiNotFound(req, res, next) {
  // Only handle /api/* paths here; other paths fall through to SPA fallback
  if (!req.path.startsWith('/api/')) return next();
  return res.status(404).json({
    ok: false,
    error: {
      code: 'NOT_FOUND',
      message: `API route not found: ${req.method} ${req.path}`,
    },
  });
}

// eslint-disable-next-line no-unused-vars
export function globalErrorHandler(err, req, res, _next) {
  // MySQL / connection errors are the most common — map them to a clean shape
  const isDbError =
    err && (err.code === 'ER_' || /mysql|mariadb|econnrefused/i.test(err.message || ''));

  // Already a structured response failure? Just re-emit it.
  if (err && err.isResponseError) {
    const { code, message, status, details } = err;
    return res.status(status || 500).json({
      ok: false,
      error: { code, message, ...(details ? { details } : {}) },
    });
  }

  const code = isDbError ? ErrorCodes.DB_ERROR.code : ErrorCodes.INTERNAL_ERROR.code;
  const status = isDbError ? ErrorCodes.DB_ERROR.status : 500;
  const message =
    process.env.NODE_ENV === 'production'
      ? (isDbError ? 'Database error' : 'Internal server error')
      : (err.message || 'Unknown error');

  console.error(
    `[errorHandler] ${req.method} ${req.path} →`,
    err.code || '',
    err.message || err
  );

  return res.status(status).json({
    ok: false,
    error: { code, message },
  });
}

/**
 * Helper to throw a structured error from anywhere inside a service/controller.
 * Use like: throw new ResponseError('NOT_FOUND', 'Task not found', 404)
 */
export class ResponseError extends Error {
  constructor(code, message, status, details) {
    super(message);
    this.isResponseError = true;
    this.code = code;
    this.status = status || ErrorCodes[code]?.status || 500;
    if (details) this.details = details;
  }
}
