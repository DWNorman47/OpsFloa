/**
 * Polls AssemblyAI for recordings stuck in 'processing' and stores the
 * finished transcript (diarized utterances) when it completes.
 *
 * Why polling instead of webhooks: the backend runs on Render behind a
 * single public URL, but local dev has none, and at this feature's volume
 * (a handful of recordings per week per company) a 20-second sweep over a
 * partial index is effectively free. The routes also schedule a one-off
 * early poll after submit so short clips feel snappy.
 *
 * Every transition is guarded by `AND status = 'processing'` so a stale
 * poll result can never clobber a row a retry has already moved on.
 */

const cron = require('node-cron');
const pool = require('../db');
const logger = require('../logger');
const { runJob } = require('./runJob');
const assemblyai = require('../services/assemblyai');

const UTTERANCE_INSERT_CHUNK = 200;

/** Store a completed transcript's utterances atomically. */
async function storeCompleted(recordingId, transcript) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE recordings
       SET status = 'completed', duration_seconds = $2, language_code = $3,
           error_message = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'processing'
       RETURNING id`,
      [recordingId, Math.round(transcript.audio_duration) || null, transcript.language_code || null]
    );
    if (upd.rowCount === 0) { await client.query('ROLLBACK'); return; }

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

async function pollProcessingRecordings() {
  if (!assemblyai.isConfigured()) return;
  const { rows } = await pool.query(
    `SELECT id FROM recordings WHERE status = 'processing' AND provider_job_id IS NOT NULL ORDER BY id LIMIT 25`
  );
  for (const row of rows) {
    try {
      await pollRecordingById(row.id);
    } catch (err) {
      // One flaky fetch shouldn't stop the rest of the sweep.
      logger.warn({ err, recordingId: row.id }, 'transcriptionPoller: poll failed');
    }
  }
}

// Overlap guard — a slow AssemblyAI response must not stack sweeps.
let sweepRunning = false;

function startTranscriptionPollerJob() {
  cron.schedule('*/20 * * * * *', async () => {
    if (sweepRunning) return;
    sweepRunning = true;
    try {
      await runJob('transcriptionPoller', pollProcessingRecordings);
    } finally {
      sweepRunning = false;
    }
  });
}

module.exports = { startTranscriptionPollerJob, pollRecordingById };
