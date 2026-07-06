/**
 * Fixed-value enums for the `recordings` table (voice transcription tool).
 * See `docs/db-enums.md` for the full registry.
 *
 * Lifecycle: uploaded → processing → completed | failed.
 * `uploaded` is the just-inserted state before the AssemblyAI submit
 * responds; `failed` is retryable via POST /recordings/:id/retry.
 */

const RECORDING_STATUSES = Object.freeze(['uploaded', 'processing', 'completed', 'failed']);
const RECORDING_STATUS_DEFAULT = 'uploaded';

module.exports = {
  RECORDING_STATUSES,
  RECORDING_STATUS_DEFAULT,
};
