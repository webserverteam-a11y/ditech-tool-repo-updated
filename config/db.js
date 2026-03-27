import mysql from 'mysql2/promise';

const requiredVars = ['DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME'];
const missing = requiredVars.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`FATAL: Missing MySQL env vars: ${missing.join(', ')}`);
  console.error('Set them in Hostinger → Node.js → Environment Variables');
  console.error('Required: DB_HOST, DB_USER, DB_PASS, DB_NAME');
}

const isLocal = ['localhost', '127.0.0.1'].includes(process.env.DB_HOST);

const poolConfig = {
  user: process.env.DB_USER || '',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || '',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
};

if (isLocal && process.env.DB_SOCKET) {
  // Use Unix socket to bypass IPv6 issues on Hostinger
  poolConfig.socketPath = process.env.DB_SOCKET;
} else {
  poolConfig.host = process.env.DB_HOST || '127.0.0.1';
  poolConfig.port = parseInt(process.env.DB_PORT || '3306', 10);
}

const pool = mysql.createPool(poolConfig);

// No top-level await — connection is verified lazily on first query
console.log('MySQL pool created for', process.env.DB_NAME || '(no DB_NAME set)');

export default pool;
