/**
 * reset-passwords.js
 * One-time script: re-encrypts all user passwords with the CURRENT key.
 * New passwords: Admin → Admin@123, everyone else → <Name>@123
 * Run: node --env-file=".env" scripts/reset-passwords.js
 */

import pool from '../config/db.js';
import { encrypt } from '../config/crypto.js';

const newPasswords = {
  admin:               'Admin@123',
  gauri:               'Gauri@123',
  heena:               'Heena@123',
  imran:               'Imran@123',
  kamna:               'Kamna@123',
  hemang:              'Hemang@123',
  manish:              'Manish@123',
  shubham:             'Shubham@123',
  'user-1776060000708': 'Pathak@123',    // Pathak
  'user-1776061003266': 'Patel@123',     // Patel
  'user-1776062077960': 'HemangP@123',   // Hemang_P
  'user-1776062283928': 'Sunil@123',     // Sunil
  'user-1776664743085': 'Interns@123',   // Interns
};

const [rows] = await pool.query('SELECT id, name FROM users');
console.log(`\nResetting passwords for ${rows.length} users...\n`);

for (const user of rows) {
  const plain = newPasswords[user.id] || (user.name + '@123');
  const enc   = encrypt(plain);
  await pool.query('UPDATE users SET password = ? WHERE id = ?', [enc, user.id]);
  console.log(`  ${user.name.padEnd(12)} (${user.id.padEnd(26)}) → ${plain}`);
}

console.log('\nAll passwords reset. You can now login with the credentials above.');
await pool.end();
