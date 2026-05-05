/**
 * routes/index.js — Mounts all feature route modules under /api.
 *
 * Mount order: specific static paths first, wildcard params last.
 * keywords router is intentionally mounted twice:
 *   /api/historical-keywords  — CRUD endpoints (GET/POST/PATCH/:id/DELETE/:id)
 *   /api/keywords             — upload-csv endpoint (POST /upload-csv)
 */

import { Router } from 'express';
import { healthRouter }      from './health.routes.js';
import { authRouter }        from './auth.routes.js';
import { tasksRouter }       from './tasks.routes.js';
import { clientsRouter }     from './clients.routes.js';
import { clientConfigRouter } from './client-config.routes.js';
import { keywordsRouter }    from './keywords.routes.js';
import { leaveRouter }       from './leave.routes.js';
import { workhubRouter }     from './workhub.routes.js';
import { auditRouter }       from './audit.routes.js';
import { configRouter }      from './config.routes.js';

export function buildApiRouter() {
  const router = Router();

  // Health / ops (no auth)
  router.use('/', healthRouter);

  // Auth
  router.use('/', authRouter);                          // POST /api/login

  // Feature resources
  router.use('/tasks',               tasksRouter);
  router.use('/clients',             clientsRouter);
  router.use('/client-config',       clientConfigRouter);
  router.use('/historical-keywords', keywordsRouter);   // GET/POST/PATCH/:id/DELETE/:id
  router.use('/keywords',            keywordsRouter);   // POST /upload-csv
  router.use('/leave-records',       leaveRouter);
  router.use('/workhub-remarks',     workhubRouter);
  router.use('/audit',               auditRouter);
  router.use('/config',              configRouter);

  return router;
}
