/**
 * auth.js — Session auth middleware
 *
 * Step 1 scaffolding: exports a no-op middleware that lets everything through.
 * In Step 3 (auth migration), this will:
 *   1. Read the session token from the Authorization header or cookie
 *   2. Look it up in the `sessions` table
 *   3. Attach the user object to req.user
 *   4. res.fail('UNAUTHORIZED', ...) if token missing/expired
 *
 * Leaving it as a pass-through for now keeps Step 1 strictly additive —
 * no endpoint behavior changes until we explicitly wire auth up.
 */

export function requireAuth(_req, _res, next) {
  // TODO [Step 3]: real session check goes here
  return next();
}

/**
 * Department/role gate. Usage:
 *   router.put('/tasks/:id', requireAuth, requireRole('admin', 'seo'), handler)
 * In Step 1 this is also a no-op; activated in Step 3.
 */
export function requireRole(..._roles) {
  return function (_req, _res, next) {
    // TODO [Step 3]: check req.user.role against roles
    return next();
  };
}
