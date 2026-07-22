/**
 * The version of the legal documents (EULA + Privacy Policy) currently in force.
 * Stamped onto each acceptance record in `legal_acceptances`, so the audit trail
 * says exactly which version a user agreed to.
 *
 * Matches the "Last updated" date on the EULA / Privacy pages. Bump BOTH — this
 * constant and that date on the pages — whenever those documents materially
 * change, and existing users should be re-prompted to accept.
 */
const LEGAL_VERSION = '2025-03-21';

module.exports = { LEGAL_VERSION };
