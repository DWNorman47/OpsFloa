/**
 * Voice transcription tool (Tools module).
 *
 * Upload flow (mirrors field-report videos): the browser asks for a
 * presigned R2 PUT URL, uploads the audio directly, then POSTs the
 * resulting public URL here. We submit that URL to AssemblyAI with
 * speaker diarization on; server/jobs/transcriptionPoller.js stores the
 * finished utterances.
 *
 * Mounted in index.js with requireAuth + requirePlan('business').
 * Workers see their own recordings; admins see the whole company's.
 */

const router = require('express').Router();
const anthropic = require('../services/anthropic');
const { runAi, MAX_INPUT } = require('../services/aiGate');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getPresignedUploadUrl, getObjectMetadataByUrl, deleteByUrl } = require('../r2');
const { checkStorageLimit, decrementStorage } = require('../storage');
const { logAudit } = require('../auditLog');
const assemblyai = require('../services/assemblyai');
const { RECORDING_STATUSES } = require('../constants/recordingEnums');
const { pollRecordingById } = require('../jobs/transcriptionPoller');
const { hasPerm } = require('../permissions');

// 2 GB cap per file — far above any realistic meeting recording, below the
// R2 single-PUT limit. Plan storage limits are the real ceiling.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

// Content types the upload-url endpoint will presign. Keys map to the file
// extension used for the R2 key. Voice memos are audio/mp4 or audio/x-m4a;
// browser MediaRecorder output is audio/webm or video/webm. Video is fine:
// AssemblyAI extracts the audio track from video files itself.
const AUDIO_CONTENT_TYPES = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/avi': 'avi',
  'video/x-msvideo': 'avi',
  'video/3gpp': '3gp',
};

const SUPPORTED_TYPES_MSG = 'Unsupported file type. Use mp3, m4a, wav, aac, ogg, flac, or a video file (mp4, mov, webm, mkv, avi, 3gp).';

function isAdmin(user) {
  return user.role === 'admin' || user.role === 'super_admin';
}

function settingIsFalse(value) {
  return value === false || value === 0 || value === '0' || value === 'false';
}

async function requireToolsModuleAccess(req, res, next) {
  try {
    const setting = await pool.query(
      "SELECT value FROM settings WHERE company_id = $1 AND key = 'module_tools'",
      [req.user.company_id]
    );
    if (setting.rows.length && settingIsFalse(setting.rows[0].value)) {
      return res.status(403).json({
        error: 'Tools are turned off for this company.',
        code: 'module_disabled',
      });
    }

    const allowed = await hasPerm(req, 'view_projects')
      || await hasPerm(req, 'manage_projects')
      || await hasPerm(req, 'manage_settings');
    if (!allowed) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'permission_denied',
        required: 'tools',
      });
    }
    next();
  } catch (err) {
    req.log?.error?.({ err }, 'recordings access check failed');
    res.status(500).json({ error: 'Permission check failed' });
  }
}

/** Fetch one recording scoped to the company, or null. */
async function loadRecording(id, companyId) {
  const { rows } = await pool.query(
    'SELECT * FROM recordings WHERE id = $1 AND company_id = $2',
    [id, companyId]
  );
  return rows[0] || null;
}

/** Schedule a one-off early poll so short clips complete without waiting
 *  for the cron sweep. Fire-and-forget; the sweep is the safety net. */
function scheduleEarlyPoll(recordingId) {
  setTimeout(() => {
    pollRecordingById(recordingId).catch(() => { /* sweep will retry */ });
  }, 8000).unref?.();
}

// GET /recordings — paginated list; worker gets own, admin gets company feed
async function discardPendingUpload(upload) {
  if (!upload) return;
  await pool.query('DELETE FROM recording_uploads WHERE id = $1', [upload.id]).catch(() => {});
  deleteByUrl(upload.public_url).catch(() => {});
}

function ensureAuthenticated(req, res, next) {
  if (req.user) return next();
  return requireAuth(req, res, next);
}

router.use(ensureAuthenticated, requireToolsModuleAccess);

router.get('/', async (req, res) => {
  const companyId = req.user.company_id;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  try {
    const { status, project_id } = req.query;
    const conditions = ['r.company_id = $1'];
    const params = [companyId];

    if (!isAdmin(req.user)) {
      params.push(req.user.id);
      conditions.push(`r.user_id = $${params.length}`);
    }
    if (status) {
      if (!RECORDING_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
      params.push(status);
      conditions.push(`r.status = $${params.length}`);
    }
    if (project_id) {
      params.push(project_id);
      conditions.push(`r.project_id = $${params.length}`);
    }

    const where = conditions.join(' AND ');
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM recordings r WHERE ${where}`, params),
      pool.query(
        `SELECT r.id, r.title, r.audio_url, r.size_bytes, r.duration_seconds, r.status,
                r.error_message, r.speaker_names, r.language_code, r.project_id,
                r.media_kind, r.media_deleted_at, r.minutes_md, r.minutes_at,
                r.created_at, r.completed_at, r.user_id,
                u.full_name AS uploader_name, p.name AS project_name
         FROM recordings r
         LEFT JOIN users u ON r.user_id = u.id
         LEFT JOIN projects p ON r.project_id = p.id
         WHERE ${where}
         ORDER BY r.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countResult.rows[0].count);
    res.json({ items: dataResult.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /recordings/upload-url — presigned URL for direct browser→R2 audio upload
router.post('/upload-url', async (req, res) => {
  const { contentType, size } = req.body || {};
  const companyId = req.user.company_id;
  const sizeBytes = parseInt(size) || 0;
  try {
    if (!assemblyai.isConfigured()) {
      return res.status(400).json({ error: 'Transcription is not set up on this server (missing AssemblyAI API key). Ask your administrator to configure it.' });
    }
    const ext = AUDIO_CONTENT_TYPES[contentType];
    if (!ext) return res.status(400).json({ error: SUPPORTED_TYPES_MSG });
    if (sizeBytes <= 0) return res.status(400).json({ error: 'Missing file size' });
    if (sizeBytes > MAX_UPLOAD_BYTES) return res.status(400).json({ error: 'File too large (max 2 GB)' });

    const { allowed, used, limit } = await checkStorageLimit(companyId, sizeBytes);
    if (!allowed) {
      return res.status(413).json({
        error: `Storage limit reached (${(used / (1024 * 1024)).toFixed(0)} MB of ${(limit / (1024 * 1024)).toFixed(0)} MB used). Upgrade your plan to upload more media.`,
        storage_limit: true,
      });
    }
    const { uploadUrl, publicUrl, key } = await getPresignedUploadUrl('recordings', ext, contentType);
    const upload = await pool.query(
      `INSERT INTO recording_uploads
         (company_id, user_id, object_key, public_url, expected_size_bytes, content_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [companyId, req.user.id, key, publicUrl, sizeBytes, contentType]
    );
    res.json({ uploadId: upload.rows[0].id, uploadUrl, publicUrl });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Failed to generate upload URL' }); }
});

// POST /recordings — register the uploaded file and submit for transcription
router.post('/', async (req, res) => {
  const { audio_url, upload_id, project_id } = req.body || {};
  const title = req.body?.title?.trim().slice(0, 300) || null;
  const companyId = req.user.company_id;
  try {
    if (!upload_id) return res.status(400).json({ error: 'Missing upload id' });

    // Only accept files that actually live in our R2 bucket — anything else
    // would let a caller run arbitrary URLs through our AssemblyAI account.
    if (!audio_url || !audio_url.startsWith(`${process.env.R2_PUBLIC_URL}/recordings/`)) {
      return res.status(400).json({ error: 'Invalid audio URL' });
    }

    const uploadResult = await pool.query(
      'SELECT * FROM recording_uploads WHERE id = $1 AND company_id = $2',
      [upload_id, companyId]
    );
    const upload = uploadResult.rows[0];
    if (!upload) return res.status(400).json({ error: 'Upload reservation not found' });
    if (upload.claimed_at) return res.status(409).json({ error: 'Upload has already been used' });
    if (new Date(upload.expires_at) < new Date()) {
      await discardPendingUpload(upload);
      return res.status(400).json({ error: 'Upload expired. Please choose the file again.' });
    }
    if (upload.user_id !== req.user.id && !isAdmin(req.user)) {
      return res.status(403).json({ error: 'Not your upload' });
    }
    if (audio_url !== upload.public_url) {
      return res.status(400).json({ error: 'Audio URL does not match this upload' });
    }

    let metadata;
    try {
      metadata = await getObjectMetadataByUrl(audio_url);
    } catch (headErr) {
      req.log.warn({ err: headErr, uploadId: upload.id }, 'recording upload head failed');
      return res.status(400).json({ error: 'Uploaded file was not found. Please try the upload again.' });
    }
    if (!metadata || metadata.key !== upload.object_key) {
      return res.status(400).json({ error: 'Uploaded file does not match this reservation' });
    }
    const actualSizeBytes = parseInt(metadata.contentLength || 0, 10);
    if (actualSizeBytes <= 0) {
      await discardPendingUpload(upload);
      return res.status(400).json({ error: 'Uploaded file is empty' });
    }
    if (actualSizeBytes > MAX_UPLOAD_BYTES) {
      await discardPendingUpload(upload);
      return res.status(400).json({ error: 'File too large (max 2 GB)' });
    }
    const actualType = String(metadata.contentType || upload.content_type).split(';')[0].trim().toLowerCase();
    if (!AUDIO_CONTENT_TYPES[actualType] && !AUDIO_CONTENT_TYPES[String(upload.content_type || '').toLowerCase()]) {
      await discardPendingUpload(upload);
      return res.status(400).json({ error: SUPPORTED_TYPES_MSG });
    }

    const { allowed, used, limit } = await checkStorageLimit(companyId, actualSizeBytes);
    if (!allowed) {
      await discardPendingUpload(upload);
      return res.status(413).json({
        error: `Storage limit reached (${(used / (1024 * 1024)).toFixed(0)} MB of ${(limit / (1024 * 1024)).toFixed(0)} MB used). Upgrade your plan to upload more media.`,
        storage_limit: true,
      });
    }

    if (project_id) {
      const proj = await pool.query('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [project_id, companyId]);
      if (proj.rowCount === 0) return res.status(400).json({ error: 'Project not found' });
    }

    const client = await pool.connect();
    let recording;
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `UPDATE recording_uploads
         SET claimed_at = NOW()
         WHERE id = $1 AND company_id = $2 AND claimed_at IS NULL AND expires_at > NOW()
         RETURNING id`,
        [upload.id, companyId]
      );
      if (claimed.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Upload has already been used or expired' });
      }
      // Video is staged only: the transcription poller deletes it from R2
      // and refunds the storage once the transcript completes.
      const mediaKind = actualType.startsWith('video/')
        || String(upload.content_type || '').toLowerCase().startsWith('video/') ? 'video' : 'audio';
      const inserted = await client.query(
        `INSERT INTO recordings (company_id, user_id, project_id, title, audio_url, size_bytes, media_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [companyId, req.user.id, project_id || null, title, audio_url, actualSizeBytes, mediaKind]
      );
      await client.query(
        'UPDATE companies SET storage_bytes_used = storage_bytes_used + $2 WHERE id = $1',
        [companyId, actualSizeBytes]
      );
      await client.query('COMMIT');
      recording = inserted.rows[0];
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    // Submit to AssemblyAI. A failed submit is a retryable 'failed' row,
    // not a lost upload — the audio is safe in R2.
    try {
      const transcript = await assemblyai.submitTranscription(audio_url);
      const upd = await pool.query(
        `UPDATE recordings SET status = 'processing', provider_job_id = $2, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [recording.id, transcript.id]
      );
      recording = upd.rows[0];
      scheduleEarlyPoll(recording.id);
    } catch (submitErr) {
      req.log.warn({ err: submitErr, recordingId: recording.id }, 'assemblyai submit failed');
      const upd = await pool.query(
        `UPDATE recordings SET status = 'failed', error_message = $2, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [recording.id, 'Could not submit for transcription. Use Retry to try again.']
      );
      recording = upd.rows[0];
    }

    logAudit(companyId, req.user.id, req.user.full_name, 'recording.created', 'recording', recording.id, title,
      { project_id: project_id || null, size_bytes: actualSizeBytes });

    res.status(201).json(recording);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /recordings/:id — recording + diarized utterances
router.get('/:id', async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const recording = await loadRecording(req.params.id, companyId);
    if (!recording) return res.status(404).json({ error: 'Recording not found' });
    if (!isAdmin(req.user) && recording.user_id !== req.user.id) return res.status(403).json({ error: 'Not your recording' });

    const utterances = await pool.query(
      `SELECT speaker, start_ms, end_ms, text, confidence
       FROM recording_utterances WHERE recording_id = $1 ORDER BY start_ms, id`,
      [recording.id]
    );
    res.json({ ...recording, utterances: utterances.rows });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// --- Meeting minutes ------------------------------------------------------

// Why this lives here and not in officeTools: the whole point of minutes over a
// generic summary is that it knows WHO said what. The transcript is diarized and
// speaker_names maps the provider's letters to real people, so the prompt can be
// told "Mike owes the RFI answer" instead of guessing from flat text. Copying the
// transcript into the Summarizer by hand throws exactly that away.
const MINUTES_SYSTEM =
  'You turn a transcript of a construction meeting (owner/architect/contractor, ' +
  'coordination, pre-con, subcontractor) into minutes. The transcript is labelled ' +
  'with who spoke. Use ONLY what is in it — never invent decisions, names, dates, ' +
  'numbers or commitments. Speech is messy: ignore small talk and false starts, ' +
  'and do not turn thinking-out-loud into a decision.\n\n' +
  'Output GitHub-flavored markdown with these sections, omitting any that do not ' +
  'apply:\n' +
  '"## Summary" — 2-4 sentences on what the meeting was about and what came of it.\n' +
  '"## Decisions" — bullets. Only things actually settled. If a decision has a ' +
  'condition ("if the slab passes Friday"), keep the condition.\n' +
  '"## Action items" — bullets, each starting with the owner in bold and ending ' +
  'with a due date when one was said, e.g. "**Mike:** order rebar — by Monday". ' +
  'Use the speaker labels exactly as the transcript gives them. Some speakers ' +
  'may be un-named and appear as "Speaker A" - keep that label as-is; never ' +
  'invent a name for them, and never guess which real person they are, even if ' +
  'the conversation hints at it. If nobody was named for an item at all, write ' +
  '"**Unassigned:**".\n' +
  '"## Open questions" — bullets. Things raised and left unresolved; this is the ' +
  'section that stops an item quietly dying between meetings.\n\n' +
  'If the recording is not a meeting (a voice memo, a phone call, one person ' +
  'talking) say so in one line and give just a Summary. Output only the markdown ' +
  'shapes above: ## headings, - bullets, **bold**.';

// POST /recordings/:id/minutes — generate + store minutes for a recording
router.post('/:id/minutes', async (req, res) => {
  const companyId = req.user.company_id;
  let recording;
  try {
    recording = await loadRecording(req.params.id, companyId);
    if (!recording) return res.status(404).json({ error: 'Recording not found' });
    if (!isAdmin(req.user) && recording.user_id !== req.user.id) return res.status(403).json({ error: 'Not your recording' });
    if (recording.status !== 'completed') {
      return res.status(409).json({ error: 'That recording is still transcribing — minutes need a finished transcript.' });
    }
  } catch (err) {
    req.log.error({ err }, 'route error');
    return res.status(500).json({ error: 'Server error' });
  }

  let transcript, clipped;
  try {
    const { rows } = await pool.query(
      `SELECT speaker, text FROM recording_utterances WHERE recording_id = $1 ORDER BY start_ms, id`,
      [recording.id]
    );
    if (!rows.length) return res.status(409).json({ error: 'That recording has no transcript to work from.' });
    // Resolve the provider's letter labels to real names where they've been set;
    // that mapping is the entire edge minutes have over a pasted transcript.
    const names = recording.speaker_names || {};
    // Same rule as speakerLabel() in TranscriptionTool: a missing OR blank name
    // falls back to the provider's letter, so an un-named meeting still yields
    // usable minutes ("Speaker A owes the RFI") rather than nothing.
    const label = sp => (names[sp] || '').trim() || `Speaker ${sp}`;
    const line = u => `${label(u.speaker)}: ${u.text}`;
    const full = rows.map(line).join('\n');
    transcript = full.slice(0, MAX_INPUT);
    clipped = full.length > MAX_INPUT;
  } catch (err) {
    req.log.error({ err }, 'minutes transcript build failed');
    return res.status(500).json({ error: 'Server error' });
  }

  await runAi(req, res, async () => {
    const result = await anthropic.generate({
      system: MINUTES_SYSTEM,
      prompt: `Meeting transcript:\n"""\n${transcript}\n"""\n\nWrite the minutes.`,
      maxTokens: 2000,
    });
    // Persist so minutes survive the tab. Best-effort: if the write fails the
    // user still gets the minutes back rather than a 502 on a call they paid for.
    try {
      await pool.query(
        'UPDATE recordings SET minutes_md = $1, minutes_at = now() WHERE id = $2 AND company_id = $3',
        [result, recording.id, companyId]
      );
    } catch (err) {
      if (req.log && req.log.error) req.log.error({ err }, 'minutes save failed');
    }
    logAudit(companyId, req.user.id, req.user.full_name, 'recording.minutes_generated', 'recording', recording.id, recording.title, {});
    return { result, clipped, minutes_at: new Date().toISOString() };
  });
});

// --- Daily log ------------------------------------------------------------

// The "voice memo → daily log" tool. Same shape as minutes, but pointed at a
// jobsite instead of a meeting: a super or foreman walks the site talking
// ("poured the north footings, waiting on the rebar delivery, lost an hour to
// rain") and gets back a structured daily log. Delays and blockers get their own
// section on purpose — a dated, contemporaneous note of a delay is exactly what
// a delay claim later stands on.
const DAILY_LOG_SYSTEM =
  'You turn a jobsite recording — usually one person walking the site talking, ' +
  'sometimes a short crew huddle — into a construction daily log. Use ONLY what ' +
  'is in the transcript. Never invent quantities, names, dates, weather, or ' +
  'events that were not spoken. Speech is messy: ignore small talk and false ' +
  'starts, and do not turn thinking-out-loud into a completed task.\n\n' +
  'Output GitHub-flavored markdown with these sections, in this order, OMITTING ' +
  'any the recording does not mention (do not emit an empty section, and do not ' +
  'write "none" — just leave it out):\n' +
  '"## Summary" — 1-3 sentences on the day on site.\n' +
  '"## Work completed" — bullets of what actually got done.\n' +
  '"## Crew & manpower" — who was on site / headcount, if mentioned.\n' +
  '"## Materials & deliveries" — what arrived, is on site, or is short.\n' +
  '"## Equipment" — equipment used, delivered, or down.\n' +
  '"## Delays, issues & blockers" — anything that cost or will cost time ' +
  '(weather, no-shows, missing material, RFIs, inspections). Keep the cause and ' +
  'any stated duration ("lost ~2 hrs to rain").\n' +
  '"## Weather" — only if weather was mentioned.\n' +
  '"## Safety" — incidents, near-misses, or safety notes, if any.\n' +
  '"## Action items" — bullets, each starting with the owner in bold and a due ' +
  'date when one was said, e.g. "**Luis:** chase the rebar delivery — first ' +
  'thing tomorrow". If nobody was named, write "**Unassigned:**".\n\n' +
  'The transcript may be labelled with speaker letters or names — use them as ' +
  'given, keep an un-named "Speaker A" as-is, and never guess who they are. If ' +
  'the recording clearly is not a jobsite update (e.g. a formal meeting), give ' +
  'just a Summary and note that briefly. Output only the markdown shapes above: ' +
  '## headings, - bullets, **bold**.';

// POST /recordings/:id/daily-log — generate + store a daily log for a recording
router.post('/:id/daily-log', async (req, res) => {
  const companyId = req.user.company_id;
  let recording;
  try {
    recording = await loadRecording(req.params.id, companyId);
    if (!recording) return res.status(404).json({ error: 'Recording not found' });
    if (!isAdmin(req.user) && recording.user_id !== req.user.id) return res.status(403).json({ error: 'Not your recording' });
    if (recording.status !== 'completed') {
      return res.status(409).json({ error: 'That recording is still transcribing — a daily log needs a finished transcript.' });
    }
  } catch (err) {
    req.log.error({ err }, 'route error');
    return res.status(500).json({ error: 'Server error' });
  }

  let transcript, clipped;
  try {
    const { rows } = await pool.query(
      `SELECT speaker, text FROM recording_utterances WHERE recording_id = $1 ORDER BY start_ms, id`,
      [recording.id]
    );
    if (!rows.length) return res.status(409).json({ error: 'That recording has no transcript to work from.' });
    const names = recording.speaker_names || {};
    const label = sp => (names[sp] || '').trim() || `Speaker ${sp}`;
    const line = u => `${label(u.speaker)}: ${u.text}`;
    const full = rows.map(line).join('\n');
    transcript = full.slice(0, MAX_INPUT);
    clipped = full.length > MAX_INPUT;
  } catch (err) {
    req.log.error({ err }, 'daily log transcript build failed');
    return res.status(500).json({ error: 'Server error' });
  }

  await runAi(req, res, async () => {
    const result = await anthropic.generate({
      system: DAILY_LOG_SYSTEM,
      prompt: `Jobsite recording transcript:\n"""\n${transcript}\n"""\n\nWrite the daily log.`,
      maxTokens: 2000,
    });
    // Best-effort persist (see minutes above for why a failed write still returns
    // the log rather than 502-ing a call the user was already metered for).
    try {
      await pool.query(
        'UPDATE recordings SET daily_log_md = $1, daily_log_at = now() WHERE id = $2 AND company_id = $3',
        [result, recording.id, companyId]
      );
    } catch (err) {
      if (req.log && req.log.error) req.log.error({ err }, 'daily log save failed');
    }
    logAudit(companyId, req.user.id, req.user.full_name, 'recording.daily_log_generated', 'recording', recording.id, recording.title, {});
    return { result, clipped, daily_log_at: new Date().toISOString() };
  });
});

// PATCH /recordings/:id — rename title, assign project, set speaker names
router.patch('/:id', async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const recording = await loadRecording(req.params.id, companyId);
    if (!recording) return res.status(404).json({ error: 'Recording not found' });
    if (!isAdmin(req.user) && recording.user_id !== req.user.id) return res.status(403).json({ error: 'Not your recording' });

    let title = recording.title;
    if (req.body.title !== undefined) {
      title = req.body.title?.trim().slice(0, 300) || null;
    }

    let projectId = recording.project_id;
    if (req.body.project_id !== undefined) {
      projectId = req.body.project_id || null;
      if (projectId) {
        const proj = await pool.query('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [projectId, companyId]);
        if (proj.rowCount === 0) return res.status(400).json({ error: 'Project not found' });
      }
    }

    // speaker_names: { "A": "Mike", "B": "Maria", ... } — display-name
    // overrides for the provider's letter labels.
    let speakerNames = recording.speaker_names;
    if (req.body.speaker_names !== undefined) {
      const raw = req.body.speaker_names;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return res.status(400).json({ error: 'speaker_names must be an object' });
      }
      const entries = Object.entries(raw);
      if (entries.length > 26) return res.status(400).json({ error: 'Too many speakers' });
      const clean = {};
      for (const [key, value] of entries) {
        if (typeof key !== 'string' || key.length > 10) return res.status(400).json({ error: 'Invalid speaker key' });
        if (typeof value !== 'string' || value.length > 100) return res.status(400).json({ error: 'Speaker names must be strings (max 100 characters)' });
        const trimmed = value.trim();
        if (trimmed) clean[key] = trimmed; // empty = revert to default label
      }
      speakerNames = clean;
    }

    const result = await pool.query(
      `UPDATE recordings SET title = $1, project_id = $2, speaker_names = $3, updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [title, projectId, JSON.stringify(speakerNames), recording.id]
    );
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /recordings/:id/retry — resubmit a failed recording
router.post('/:id/retry', async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const recording = await loadRecording(req.params.id, companyId);
    if (!recording) return res.status(404).json({ error: 'Recording not found' });
    if (!isAdmin(req.user) && recording.user_id !== req.user.id) return res.status(403).json({ error: 'Not your recording' });
    if (recording.status !== 'failed') return res.status(400).json({ error: 'Only failed recordings can be retried' });
    if (!assemblyai.isConfigured()) {
      return res.status(400).json({ error: 'Transcription is not set up on this server (missing AssemblyAI API key).' });
    }

    try {
      const transcript = await assemblyai.submitTranscription(recording.audio_url);
      const upd = await pool.query(
        `UPDATE recordings SET status = 'processing', provider_job_id = $2, error_message = NULL, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [recording.id, transcript.id]
      );
      scheduleEarlyPoll(recording.id);
      return res.json(upd.rows[0]);
    } catch (submitErr) {
      req.log.warn({ err: submitErr, recordingId: recording.id }, 'assemblyai retry submit failed');
      const upd = await pool.query(
        `UPDATE recordings SET error_message = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [recording.id, 'Could not submit for transcription. Use Retry to try again.']
      );
      return res.json(upd.rows[0]);
    }
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /recordings/:id — delete recording, transcript, and the R2 audio
router.delete('/:id', async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const recording = await loadRecording(req.params.id, companyId);
    if (!recording) return res.status(404).json({ error: 'Recording not found' });
    if (!isAdmin(req.user) && recording.user_id !== req.user.id) return res.status(403).json({ error: 'Not your recording' });

    await pool.query('DELETE FROM recordings WHERE id = $1 AND company_id = $2', [recording.id, companyId]);

    // Read outside the branch: the audit line below logs it either way, and
    // scoping it to the if meant deleting an already-swept recording threw a
    // ReferenceError *after* the row was gone — a 500 and no audit trail.
    const sizeBytes = parseInt(recording.size_bytes || 0);
    // Staged video is already gone from R2 (and refunded) once the poller
    // has set media_deleted_at — don't delete or refund twice.
    if (!recording.media_deleted_at) {
      deleteByUrl(recording.audio_url).catch(() => {});
      if (sizeBytes > 0) decrementStorage(companyId, sizeBytes).catch(() => {});
    }

    logAudit(companyId, req.user.id, req.user.full_name, 'recording.deleted', 'recording', recording.id, recording.title,
      { size_bytes: sizeBytes, status: recording.status });

    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
