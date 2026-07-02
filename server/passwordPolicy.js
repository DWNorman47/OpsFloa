/**
 * Single source of truth for password rules. Used by the auth routes
 * (register / reset / change) and the superadmin "set password" action so
 * the policy can't drift between them.
 *
 * Returns an error string when invalid, or null when the password passes.
 */
function validatePassword(password, username) {
  // NIST SP 800-63B modern guidance: favour length over forced complexity.
  // 8-char minimum is the conservative floor; max stays at 128.
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 128) return 'Password must be 128 characters or fewer';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'Password cannot contain your username';
  return null;
}

module.exports = { validatePassword };
