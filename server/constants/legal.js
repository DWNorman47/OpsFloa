/**
 * The version of the legal documents (EULA + Privacy Policy) currently in force.
 * Stamped onto each acceptance record in `legal_acceptances`, so the audit trail
 * says exactly which version a user agreed to.
 *
 * Matches the "Last updated" date on the EULA / Privacy pages. Bump BOTH — this
 * constant and that date on the pages — whenever those documents materially
 * change; users without an acceptance row for the current version are re-prompted
 * by the login gate (see TermsGate / GET /auth/me `needs_terms`).
 */
const LEGAL_VERSION = '2026-07-22';

module.exports = { LEGAL_VERSION };
