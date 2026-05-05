import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:';

// Derive a 32-byte key from the env variable
function getKey() {
  const secret = process.env.ENCRYPTION_KEY || 'default-ditech-key-change-me-now';
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a plain text string.
 * Returns: "enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 */
export function encrypt(plainText) {
  if (!plainText || typeof plainText !== 'string') return plainText;
  if (plainText.startsWith(PREFIX)) return plainText; // already encrypted
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt an encrypted string back to plain text.
 * If the string is not encrypted (no prefix), returns as-is.
 */
export function decrypt(encryptedText) {
  if (!encryptedText || typeof encryptedText !== 'string') return encryptedText;
  if (!encryptedText.startsWith(PREFIX)) return encryptedText; // plain text, not encrypted
  try {
    const parts = encryptedText.slice(PREFIX.length).split(':');
    if (parts.length !== 3) return encryptedText;
    const [ivHex, authTagHex, cipherHex] = parts;
    const key = getKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('Decrypt failed:', e.message);
    return encryptedText; // return as-is if decryption fails
  }
}

/**
 * Check if a string is encrypted
 */
export function isEncrypted(text) {
  return typeof text === 'string' && text.startsWith(PREFIX);
}
