/**
 * noCache.js — Sets no-cache headers on /api responses so browsers never
 * serve stale data from their HTTP cache. Matches the behavior that was
 * previously inline in server.js.
 */
export function noCache(_req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
}
