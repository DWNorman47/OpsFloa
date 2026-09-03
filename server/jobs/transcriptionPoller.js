/**
 * Polls AssemblyAI for recordings stuck in 'processing' and stores the
 * finished transcript (diarized utterances) when it completes.
 *
 * Why polling instead of webhooks: the backend runs on Render behind a
 * single public URL, but local dev has none, so polling is the portable
 * choice. To avoid keeping the DB (and Neon compute) awake around the clock,
 * the 20-second sweep only runs inside a bounded window opened by a submission
 * (see notePendingTranscription / activeUntil below) — when idle it makes zero
 * queries. The routes also schedule a one-off early poll after submit so short
 * clips feel snappy.
 *
 * Every transition is guarded by `AND status = 'processing'` so a stale
 * poll result can never clobber a row a retry has already moved on.
 */

const cron = require('node-cron');
const pool = require('../db');
const logger = require('../logger');
const { runJob } = require('./runJob');
const assemblyai = require('../services/assemblyai');
const { deleteByUrl } = require('../r2');
const { decrementStorage } = require('../storage');

const UTTERANCE_INSERT_CHUNK = 200;

/**
 * Video files are staged in R2 only for AssemblyAI to fetch — once the
 * transcript is stored, delete the file and refund the company's storage.
 * The media_deleted_at claim guard makes this idempotent (and the DELETE
 * route skips its own delete/refund when it's set).
 */
async function cleanupStagedVideo(recording) {
  if (recording.media_kind !== 'video' || recording.media_deleted_at) return;
  const claimed = await pool.query(
    `UPDATE recordings SET media_deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND media_deleted_at IS NULL RETURNING id`,
    [recording.id]
  );
  if (claimed.rowCount === 0) return;
  deleteByUrl(recording.audio_url).catch(err =>
    logger.warn({ err, recordingId: recording.id }, 'transcriptionPoller: staged video delete failed'));
  const sizeBytes = parseInt(recording.size_bytes || 0, 10);
  if (sizeBytes > 0) {
    decrementStorage(recording.company_id, sizeBytes).catch(err =>
      logger.warn({ err, recordingId: recording.id }, 'transcriptionPoller: storage refund failed'));
  }
  logger.info({ recordingId: recording.id, sizeBytes }, 'transcriptionPoller: staged video removed');
}

/** Store a completed transcript's utterances atomically. */
async function storeCompleted(recordingId, transcript) {
  const client = await pool.connect();
  let completedRow = null;
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE recordings
       SET status = 'completed', duration_seconds = $2, language_code = $3,
           error_message = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'processing'
       RETURNING id, company_id, audio_url, size_bytes, media_kind, media_deleted_at`,
      [recordingId, Math.round(transcript.audio_duration) || null, transcript.language_code || null]
    );
    if (upd.rowCount === 0) { await client.query('ROLLBACK'); return; }
    completedRow = upd.rows[0];

    await client.query('DELETE FROM recording_utterances WHERE recording_id = $1', [recordingId]);

    // Diarized turns. If diarization produced nothing but there is text
    // (e.g. music, a single word), fall back to one Speaker-A utterance so
    // the transcript isn't silently empty.
    let utterances = Array.isArray(transcript.utterances) ? transcript.utterances : [];
    if (utterances.length === 0 && transcript.text) {
      utterances = [{ speaker: 'A', start: 0, end: (Math.round(transcript.audio_duration) || 0) * 1000, text: transcript.text, confidence: transcript.confidence ?? null }];
    }

    for (let i = 0; i < utterances.length; i += UTTERANCE_INSERT_CHUNK) {
      const chunk = utterances.slice(i, i + UTTERANCE_INSERT_CHUNK);
      const values = chunk.map((_, j) => `($1, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, $${j * 5 + 5}, $${j * 5 + 6})`).join(', ');
      const params = [recordingId];
      chunk.forEach(u => {
        params.push(
          String(u.speaker ?? 'A').slice(0, 10),
          Math.max(0, Math.round(u.start) || 0),
          Math.max(0, Math.round(u.end) || 0),
          u.text || '',
          Number.isFinite(u.confidence) ? u.confidence : null
        );
      });
      await client.query(
        `INSERT INTO recording_utterances (recording_id, speaker, start_ms, end_ms, text, confidence) VALUES ${values}`,
        params
      );
    }

    await client.query('COMMIT');
    logger.info({ recordingId, utterances: utterances.length }, 'transcriptionPoller: recording completed');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Outside the transaction — R2 is an external call, and a cleanup failure
  // must not undo a stored transcript.
  if (completedRow) {
    await cleanupStagedVideo(completedRow).catch(err =>
      logger.warn({ err, recordingId }, 'transcriptionPoller: video cleanup failed'));
  }
}

async function storeFailed(recordingId, message) {
  await pool.query(
    `UPDATE recordings
     SET status = 'failed', error_message = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'processing'`,
    [recordingId, (message || 'Transcription failed').slice(0, 1000)]
  );
  logger.warn({ recordingId, message }, 'transcriptionPoller: recording failed');
}

/**
 * Poll one recording by id. Safe to call redundantly — no-ops unless the
 * row is still 'processing'. Used by the cron sweep and by the routes'
 * one-off early poll after submit/retry.
 */
async function pollRecordingById(recordingId) {
  if (!assemblyai.isConfigured()) return;
  const { rows } = await pool.query(
    `SELECT id, provider_job_id FROM recordings WHERE id = $1 AND status = 'processing' AND provider_job_id IS NOT NULL`,
    [recordingId]
  );
  if (rows.length === 0) return;
  const transcript = await assemblyai.getTranscript(rows[0].provider_job_id);
  if (transcript.status === 'completed') await storeCompleted(recordingId, transcript);
  else if (transcript.status === 'error') await storeFailed(recordingId, transcript.error);
  // queued / processing — leave it for the next sweep.
}

// ── Bounded polling window ──────────────────────────────────────────────────────
// The 20-second sweep is the reason an always-on server keeps its Neon branch awake
// 24/7 (a DB query every 20s never lets it suspend). So the sweep now runs ONLY inside
// a bounded window that a submission opens: `activeUntil` is a deadline set to
// now + POLL_WINDOW_MS whenever a recording is submitted/retried (or once at boot to
// catch anything left over). When the window closes the sweep does nothing — zero DB
// queries — so the DB can idle and Neon scales to zero.
//
// Safety: the deadline is only ever set to a bounded `now + POLL_WINDOW_MS`; nothing
// extends it indefinitely, so the poller can never run forever. And a recording stuck
// in 'processing' is force-failed after STALE_FAIL_MS (< the window) so a bad row can
// neither hold the window open nor linger as a zombie. Worst case: the sweep runs at
// most POLL_WINDOW_MS after the last real submission, then goes silent.
const POLL_WINDOW_MS = 45 * 60 * 1000; // stop polling this long after the last submission
const STALE_FAIL_MS = 30 * 60 * 1000;  // a 'processing' row older than this is force-failed

let activeUntil = 0;

/** Open (or extend) the polling window. Called by the routes on submit/retry. */
function notePendingTranscription() {
  activeUntil = Date.now() + POLL_WINDOW_MS;
}

async function pollProcessingRecordings() {
  if (!assemblyai.isConfigured()) { activeUntil = 0; return; }
  const { rows } = await pool.query(
    `SELECT id, created_at FROM recordings
     WHERE status = 'processing' AND provider_job_id IS NOT NULL
     ORDER BY id LIMIT 25`
  );
  if (rows.length === 0) { activeUntil = 0; return; } // nothing pending → go quiet immediately

  const staleCutoff = Date.now() - STALE_FAIL_MS;
  for (const row of rows) {
    // A job that never resolves must not be polled indefinitely — fail it and move on.
    if (new Date(row.created_at).getTime() < staleCutoff) {
      await storeFailed(row.id, 'Transcription timed out').catch(err =>
        logger.warn({ err, recordingId: row.id }, 'transcriptionPoller: stale-fail failed'));
      continue;
    }
    try {
      await pollRecordingById(row.id);
    } catch (err) {
      // One flaky fetch shouldn't stop the rest of the sweep.
      logger.warn({ err, recordingId: row.id }, 'transcriptionPoller: poll failed');
    }
  }

  // If nothing is left processing, close the window so the DB can go idle.
  const { rows: remaining } = await pool.query(
    `SELECT 1 FROM recordings WHERE status = 'processing' AND provider_job_id IS NOT NULL LIMIT 1`
  );
  if (remaining.length === 0) activeUntil = 0;
}

// Overlap guard — a slow AssemblyAI response must not stack sweeps.
let sweepRunning = false;

function startTranscriptionPollerJob() {
  // One catch-up window at boot: resolve anything left 'processing' from before a
  // restart, then self-close on the first sweep if there's nothing pending.
  activeUntil = Date.now() + POLL_WINDOW_MS;
  cron.schedule('*/20 * * * * *', async () => {
    if (Date.now() > activeUntil) return; // window closed → no DB query, Neon can suspend
    if (sweepRunning) return;
    sweepRunning = true;
    try {
      await runJob('transcriptionPoller', pollProcessingRecordings);
    } finally {
      sweepRunning = false;
    }
  });
}

module.exports = { startTranscriptionPollerJob, pollRecordingById, notePendingTranscription, pollProcessingRecordings };
