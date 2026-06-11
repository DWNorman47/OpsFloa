// Symmetric encryption for secrets at rest (currently MFA TOTP seeds).
//
// AES-256-GCM with a key derived from MFA_ENCRYPTION_KEY. Designed to be
// BACKWARDS-COMPATIBLE so it can be deployed without a migration step:
//   * decrypt() passes through any value that isn't in our ciphertext
//     format, so existing PLAINTEXT secrets keep working;
//   * encrypt() returns the input unchanged when no key is configured, so
//     a deploy that hasn't set MFA_ENCRYPTION_KEY yet won't break MFA
//     (secrets simply stay plaintext until the key is set, after which new
//     writes are encrypted and old ones are re-encrypted on next write).
//
// Ciphertext format: "gcm:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>".

const crypto = require('crypto');

const PREFIX = 'gcm:v1:';

// Derive a stable 32-byte key from whatever the operator set (hex, base64,
// or a passphrase) via SHA-256, so any non-empty value is usable.
function getKey() {
  const raw = process.env.MFA_ENCRYPTION_KEY;
  if (!raw) return null;
  return crypto.createHash('sha256').update(String(raw)).digest(); // 32 bytes
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plaintext) {
  if (plaintext == null) return plaintext;
  const key = getKey();
  if (!key) return plaintext; // no key configured → leave as-is (no breakage)
  if (isEncrypted(plaintext)) return plaintext; // already encrypted
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(stored) {
  if (stored == null) return stored;
  if (!isEncrypted(stored)) return stored; // legacy plaintext → pass through
  const key = getKey();
  if (!key) {
    // Encrypted value but no key to read it — fail loud rather than silently
    // treating ciphertext as a valid secret.
    throw new Error('MFA_ENCRYPTION_KEY is required to decrypt an encrypted secret');
  }
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encrypt, decrypt, isEncrypted };
