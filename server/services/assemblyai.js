/**
 * Thin AssemblyAI client for the voice transcription tool.
 *
 * ASSEMBLYAI_API_KEY is intentionally NOT in REQUIRED_ENV (same pattern as
 * RESEND_API_KEY): a partially-configured environment still boots, and the
 * recordings routes return a clear error when the key is absent.
 *
 * Flow: submitTranscription() POSTs the R2 public URL with speaker_labels
 * on; AssemblyAI processes async; server/jobs/transcriptionPoller.js calls
 * getTranscript() until status is 'completed' or 'error'.
 */

const axios = require('axios');

const BASE_URL = 'https://api.assemblyai.com/v2';

function isConfigured() {
  return !!process.env.ASSEMBLYAI_API_KEY;
}

function client() {
  return axios.create({
    baseURL: BASE_URL,
    headers: { authorization: process.env.ASSEMBLYAI_API_KEY },
    timeout: 30000,
  });
}

/**
 * Submit an audio URL for transcription with speaker diarization.
 * Returns the created transcript object ({ id, status, ... }).
 * language_detection lets Spanish-language meetings come back correctly
 * (matches the app's English/Spanish user base).
 */
async function submitTranscription(audioUrl) {
  const { data } = await client().post('/transcript', {
    audio_url: audioUrl,
    speaker_labels: true,
    language_detection: true,
  });
  return data;
}

/**
 * Fetch a transcript by id. status is one of: queued, processing,
 * completed, error. When completed with speaker_labels, `utterances` is
 * an array of { speaker: 'A', text, start, end, confidence } turns and
 * `audio_duration` is the length in seconds.
 */
async function getTranscript(id) {
  const { data } = await client().get(`/transcript/${encodeURIComponent(id)}`);
  return data;
}

module.exports = { isConfigured, submitTranscription, getTranscript };
