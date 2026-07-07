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

// 'video' files are staged in R2 only until transcription completes, then
// deleted and their storage refunded (see transcriptionPoller.js).
const RECORDING_MEDIA_KINDS = Object.freeze(['audio', 'video']);
const RECORDING_MEDIA_KIND_DEFAULT = 'audio';

module.exports = {
  RECORDING_STATUSES,
  RECORDING_STATUS_DEFAULT,
  RECORDING_MEDIA_KINDS,
  RECORDING_MEDIA_KIND_DEFAULT,
};
