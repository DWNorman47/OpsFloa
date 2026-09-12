import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sampleRate = 48_000;
const duration = 32;
const channels = 2;
const frames = sampleRate * duration;
const tempo = 92;
const beatSeconds = 60 / tempo;
const chordSeconds = beatSeconds * 8;
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../public/audio/plan-to-paid/music-balanced.wav');

const progression = [
  { root: 47, intervals: [0, 3, 7, 14] },
  { root: 43, intervals: [0, 7, 11, 14] },
  { root: 50, intervals: [0, 4, 7, 14] },
  { root: 45, intervals: [0, 2, 7, 12] },
  { root: 47, intervals: [0, 3, 7, 14] },
  { root: 43, intervals: [0, 7, 11, 14] },
  { root: 47, intervals: [0, 3, 7, 14] },
];
const sequence = [0, 7, 14, 7, 3, 7, 14, 10];
const left = new Float32Array(frames);
const right = new Float32Array(frames);
let noiseState = 0x4f707346;
let previousNoise = 0;

function frequency(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

function noise() {
  noiseState ^= noiseState << 13;
  noiseState ^= noiseState >>> 17;
  noiseState ^= noiseState << 5;
  return ((noiseState >>> 0) / 0xffffffff) * 2 - 1;
}

function smoothStep(from, to, value) {
  const position = Math.max(0, Math.min(1, (value - from) / (to - from)));
  return position * position * (3 - 2 * position);
}

function pad(chord, time, detuneCents) {
  let value = 0;
  for (let voice = 0; voice < chord.intervals.length; voice += 1) {
    const freq = frequency(chord.root + 12 + chord.intervals[voice]) * 2 ** (detuneCents / 1200);
    const phase = 2 * Math.PI * freq * time + voice * 0.47;
    const motion = 0.9 + Math.sin(time * (0.31 + voice * 0.03) + voice) * 0.1;
    value += (Math.sin(phase) * 0.84 + Math.sin(phase * 0.5) * 0.16) * motion;
  }
  return value / chord.intervals.length;
}

for (let i = 0; i < frames; i += 1) {
  const time = i / sampleRate;
  const beat = time / beatSeconds;
  const beatIndex = Math.floor(beat);
  const beatPhase = beat - beatIndex;
  const eighth = Math.floor(beat * 2);
  const eighthPhase = beat * 2 - eighth;
  const chordPosition = time / chordSeconds;
  const chordIndex = Math.min(progression.length - 1, Math.floor(chordPosition));
  const nextChordIndex = Math.min(progression.length - 1, chordIndex + 1);
  const chordPhase = chordPosition - chordIndex;
  const crossfade = smoothStep(0.82, 1, chordPhase);
  const current = progression[chordIndex];
  const next = progression[nextChordIndex];

  const padLeft = pad(current, time, -2.2) * (1 - crossfade) + pad(next, time, -2.2) * crossfade;
  const padRight = pad(current, time, 2.2) * (1 - crossfade) + pad(next, time, 2.2) * crossfade;

  const bassRoot = frequency(current.root - 12);
  const bassNext = frequency(next.root - 12);
  const bass = Math.sin(2 * Math.PI * bassRoot * time) * (1 - crossfade)
    + Math.sin(2 * Math.PI * bassNext * time) * crossfade;

  const note = current.root + 12 + sequence[eighth % sequence.length];
  const sequenceAttack = smoothStep(0, 0.13, eighthPhase);
  const sequenceRelease = Math.exp(-eighthPhase * 2.8);
  const sequenceTone = Math.sin(2 * Math.PI * frequency(note) * time) * 0.8
    + Math.sin(2 * Math.PI * frequency(note) * 2 * time) * 0.08;
  const sequenceLevel = eighth % 4 === 2 ? 0.72 : eighth % 2 === 1 ? 0.84 : 1;
  const rollingSequence = sequenceTone * sequenceAttack * sequenceRelease * sequenceLevel;

  const kickBeat = beatIndex % 4 === 0 || beatIndex % 4 === 2;
  const kickEnvelope = kickBeat ? Math.exp(-beatPhase * 15) : 0;
  const kickPitch = 43 + 34 * Math.exp(-beatPhase * 18);
  const kick = Math.sin(2 * Math.PI * kickPitch * time) * kickEnvelope;

  const rawNoise = noise();
  const highNoise = rawNoise - previousNoise * 0.94;
  previousNoise = rawNoise;
  const textureHit = eighth % 4 === 3 && eighthPhase < 0.22;
  const texture = textureHit ? highNoise * Math.exp(-eighthPhase * 24) : 0;

  const opening = smoothStep(0, 1.4, time);
  const rhythmIn = smoothStep(1.2, 4.2, time);
  const lift = 0.82 + smoothStep(9, 20, time) * 0.18;
  const closing = 1 - smoothStep(29.4, duration, time);
  const fade = opening * closing;

  left[i] = (
    padLeft * 0.072
    + bass * 0.047
    + rollingSequence * 0.026 * rhythmIn
    + kick * 0.055 * rhythmIn
    + texture * 0.0045 * rhythmIn
  ) * fade * lift;
  right[i] = (
    padRight * 0.072
    + bass * 0.044
    + rollingSequence * 0.024 * rhythmIn
    + kick * 0.052 * rhythmIn
    + texture * 0.004 * rhythmIn
  ) * fade * lift;
}

const reverbTaps = [
  [0.12, 0.15],
  [0.21, 0.11],
  [0.34, 0.08],
  [0.49, 0.055],
];
for (const [delaySeconds, tapGain] of reverbTaps) {
  const delay = Math.round(delaySeconds * sampleRate);
  for (let i = delay; i < frames; i += 1) {
    left[i] += right[i - delay] * tapGain;
    right[i] += left[i - delay] * tapGain;
  }
}

let peak = 0;
for (let i = 0; i < frames; i += 1) {
  peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
}
const masterGain = peak > 0 ? 0.74 / peak : 1;
const pcm = Buffer.alloc(frames * channels * 2);
for (let i = 0; i < frames; i += 1) {
  const leftSample = Math.tanh(left[i] * masterGain * 1.08) / Math.tanh(1.08);
  const rightSample = Math.tanh(right[i] * masterGain * 1.08) / Math.tanh(1.08);
  pcm.writeInt16LE(Math.round(leftSample * 32767), i * 4);
  pcm.writeInt16LE(Math.round(rightSample * 32767), i * 4 + 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(channels, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * channels * 2, 28);
header.writeUInt16LE(channels * 2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat([header, pcm]));
console.log(`Generated ${output}`);
