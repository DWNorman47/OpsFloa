// Tests for the at-rest secret encryption used for MFA TOTP seeds.
// Critical that it round-trips correctly AND degrades safely (no key set,
// legacy plaintext) so deploying it can't lock anyone out of MFA.

const ORIGINAL_KEY = process.env.MFA_ENCRYPTION_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.MFA_ENCRYPTION_KEY;
  else process.env.MFA_ENCRYPTION_KEY = ORIGINAL_KEY;
  jest.resetModules();
});

function load() {
  jest.resetModules();
  return require('../utils/secretBox');
}

describe('secretBox', () => {
  test('round-trips with a key set', () => {
    process.env.MFA_ENCRYPTION_KEY = 'test-key-please-rotate';
    const { encrypt, decrypt, isEncrypted } = load();
    const secret = 'JBSWY3DPEHPK3PXP';
    const enc = encrypt(secret);
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).not.toContain(secret);
    expect(decrypt(enc)).toBe(secret);
  });

  test('uses a fresh IV each call (ciphertexts differ)', () => {
    process.env.MFA_ENCRYPTION_KEY = 'test-key';
    const { encrypt, decrypt } = load();
    const a = encrypt('SAMESECRET');
    const b = encrypt('SAMESECRET');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('SAMESECRET');
    expect(decrypt(b)).toBe('SAMESECRET');
  });

  test('passes through when no key is configured (no breakage pre-key)', () => {
    delete process.env.MFA_ENCRYPTION_KEY;
    const { encrypt, decrypt } = load();
    expect(encrypt('PLAINTEXTSEED')).toBe('PLAINTEXTSEED');
    expect(decrypt('PLAINTEXTSEED')).toBe('PLAINTEXTSEED');
  });

  test('decrypt passes legacy plaintext through even with a key set', () => {
    process.env.MFA_ENCRYPTION_KEY = 'test-key';
    const { decrypt } = load();
    // An existing plaintext secret (no ciphertext prefix) must still work.
    expect(decrypt('LEGACYPLAINTEXT')).toBe('LEGACYPLAINTEXT');
  });

  test('decrypting ciphertext without a key throws (no silent garbage)', () => {
    process.env.MFA_ENCRYPTION_KEY = 'test-key';
    const enc = load().encrypt('SECRET');
    delete process.env.MFA_ENCRYPTION_KEY;
    const { decrypt } = load();
    expect(() => decrypt(enc)).toThrow(/MFA_ENCRYPTION_KEY/);
  });

  test('null / undefined pass through', () => {
    process.env.MFA_ENCRYPTION_KEY = 'test-key';
    const { encrypt, decrypt } = load();
    expect(encrypt(null)).toBeNull();
    expect(decrypt(undefined)).toBeUndefined();
  });
});
