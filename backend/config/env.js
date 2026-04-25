/**
 * env.js — Validate required environment variables on boot.
 *
 * Called once from server.js. Logs missing vars but does NOT throw;
 * this matches the existing behavior where the server boots even with
 * missing DB creds (so the /api/health endpoint stays reachable).
 */

const REQUIRED = ['DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME'];

export function validateEnv() {
  const missing = REQUIRED.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`FATAL: Missing MySQL env vars: ${missing.join(', ')}`);
    console.error('Set them in Hostinger → Node.js → Environment Variables');
    console.error('Required: DB_HOST, DB_USER, DB_PASS, DB_NAME');
  }
  return { missing, ok: missing.length === 0 };
}
