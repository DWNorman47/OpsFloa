/**
 * r2.keyBelongsTo / safeKeyFromPublicUrl — the strict ownership check used before a
 * client-supplied R2 url is stored, proxied or deleted.
 */
process.env.R2_PUBLIC_URL = 'https://cdn.example.com';
const { keyBelongsTo, safeKeyFromPublicUrl } = require('../r2');

const B = 'https://cdn.example.com';

test('accepts a plain key under the prefix', () => {
  expect(safeKeyFromPublicUrl(`${B}/takeoffs/7/abc.pdf`)).toBe('takeoffs/7/abc.pdf');
  expect(keyBelongsTo(`${B}/takeoffs/7/abc.pdf`, 'takeoffs/7')).toBe(true);
  expect(keyBelongsTo(`${B}/takeoffs/7/abc.pdf`, 'takeoffs/7/')).toBe(true);
});

test('prefix is folder-bounded (7 does not match 77)', () => {
  expect(keyBelongsTo(`${B}/takeoffs/77/abc.pdf`, 'takeoffs/7')).toBe(false);
  expect(keyBelongsTo(`${B}/takeoffs/7`, 'takeoffs/7')).toBe(false);
  expect(keyBelongsTo(`${B}/takeoffs/7/`, 'takeoffs/7')).toBe(false);
});

test('rejects other tenants, other folders and foreign hosts', () => {
  expect(keyBelongsTo(`${B}/takeoffs/8/abc.pdf`, 'takeoffs/7')).toBe(false);
  expect(keyBelongsTo(`${B}/public-profiles/abc.jpg`, 'takeoffs/7')).toBe(false);
  expect(keyBelongsTo('https://evil.example.com/takeoffs/7/abc.pdf', 'takeoffs/7')).toBe(false);
  expect(keyBelongsTo('https://cdn.example.com.evil.com/takeoffs/7/abc.pdf', 'takeoffs/7')).toBe(false);
  expect(keyBelongsTo(null, 'takeoffs/7')).toBe(false);
  expect(keyBelongsTo(`${B}/takeoffs/7/abc.pdf`, '')).toBe(false);
});

test.each([
  'takeoffs/7/../8/abc.pdf',
  'takeoffs/7/./abc.pdf',
  'takeoffs/7//abc.pdf',
  'takeoffs/7/%2e%2e/8/abc.pdf',
  'takeoffs/7/%2E%2E/8/abc.pdf',
  'takeoffs/7/..%2f8/abc.pdf',
  'takeoffs/7/..\\8/abc.pdf',
  'takeoffs/7/abc.pdf?x=../../8',
  'takeoffs/7/abc.pdf#frag',
  'takeoffs/7/a b.pdf',
])('rejects traversal / encoded key %s', (key) => {
  expect(safeKeyFromPublicUrl(`${B}/${key}`)).toBeNull();
  expect(keyBelongsTo(`${B}/${key}`, 'takeoffs/7')).toBe(false);
});
