const rateLimit = require('express-rate-limit');
const { userOrIpKey } = require('./rateLimitKey');

// Shared rate limiters for the unauthenticated, token-keyed public routers
// (estimate / change-order / invoice / lien-waiver view + accept/decline/sign).
// These pages carry no auth — anyone with (or guessing) a token can hit them —
// so they need the same per-IP throttle the booking public router already has.
// Mirrors booking.js's publicReadLimiter / publicBookLimiter shape.

// Reads (GET /view, GET /sign): generous, page loads + polling.
const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Writes (accept / decline / sign): each mutates the DB, so tighter — this also
// blunts token brute-forcing against the mutation endpoints.
const publicWriteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { publicReadLimiter, publicWriteLimiter };
