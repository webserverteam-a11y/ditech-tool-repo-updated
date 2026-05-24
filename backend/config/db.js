/**
 * Re-exports the MySQL pool from the existing config/db.js.
 *
 * Why: we want new backend/* code to only import from backend/*, so the new
 * folder is self-contained. But we don't want to move config/db.js yet
 * because db-middleware.js and the current server.js still import it from
 * its original path. This shim gives us both.
 */
export { default } from '../../config/db.js';
