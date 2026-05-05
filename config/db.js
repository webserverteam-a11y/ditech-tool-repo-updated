import mysql from 'mysql2/promise';
import dns from 'dns';

// Force IPv4 first — prevents ::1 (IPv6) connection issues on Hostinger
dns.setDefaultResultOrder('ipv4first');

const requiredVars = ['DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME'];
const missing = requiredVars.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`FATAL: Missing MySQL env vars: ${missing.join(', ')}`);
  console.error('Set them in Hostinger → Node.js → Environment Variables');
  console.error('Required: DB_HOST, DB_USER, DB_PASS, DB_NAME');
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || '',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || '',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  waitForConnections: true,
  // Raised from 5 → 20 to support ~100 concurrent users.
  // Each in-flight API request can hold one connection for the duration of
  // its transaction; with 20 connections, up to 20 concurrent saves/reads
  // can execute simultaneously while the rest queue (queueLimit: 0 = no cap).
  connectionLimit: parseInt(process.env.DB_POOL_LIMIT || '20', 10),
  queueLimit: 0,
  connectTimeout: 15000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// No top-level await — connection is verified lazily on first query
console.log('MySQL pool created for', process.env.DB_NAME || '(no DB_NAME set)');

export default pool;
