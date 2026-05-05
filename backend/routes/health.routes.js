/**
 * health.routes.js — Mounts health/ops endpoints.
 *
 * These endpoints are intentionally unauthenticated so ops can check them
 * from anywhere. Do NOT add sensitive data to the health snapshot.
 */

import { Router } from 'express';
import { health, dbInit } from '../controllers/health.controller.js';

export const healthRouter = Router();

healthRouter.get('/health', health);
healthRouter.get('/db-init', dbInit);
