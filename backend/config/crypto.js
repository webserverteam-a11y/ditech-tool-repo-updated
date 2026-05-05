/**
 * Re-exports encrypt/decrypt/isEncrypted from the existing config/crypto.js.
 * See backend/config/db.js for the rationale behind the shim.
 */
export { encrypt, decrypt, isEncrypted } from '../../config/crypto.js';
