import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sampleRate = 48_000;
const duration = 32;
const channels = 2;
const frames = sampleRate * duration;
const tempo = 76;
const beatSeconds = 60 / tempo;
const chordSeconds = beatSeconds * 8;
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../public/audio/plan-to-paid/music-flow.wav');

const progression = [
  { root: 47, intervals: [0, 3, 7, 14] }, // Bm9
  { root: 43, intervals: [0, 7, 11, 14] }, // Gmaj9
  { root: 50, intervals: [0, 4, 7, 14] }, // Dadd9
  { root: 45, intervals: [0, 2, 7, 12] }, // Asus2
  { root: 47, intervals: [0, 3, 7, 14] }, // Bm9 resolve
];

const left = new Float32Array(frames);
const right = new Float32Array(frames);
let noiseState = 0x51a7f10;
let filteredNoiseLeft = 0;
let filteredNoiseRight = 0;

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
  if (from === to) return value >= to ? 1 : 0;
  const position = Math.max(0, Math.min(1, (value - from) / (to - from)));
  return position * position * (3 - 2 * position);
}

function chordPad(chord, time, panOffset) {
  let sample = 0;
  for (let voice = 0; voice < chord.intervals.length; voice += 1) {
    const note = chord.root + 12 + chord.intervals[voice];
    const freq = frequency(note);
    const detune = 2 ** (((voice % 2 === 0 ? -3.5 : 3.5) + panOffset) / 1200);
    const phase = 2 * Math.PI * freq * detune * time + voice * 0.61;
    const motion = 0.82 + Math.sin(time * (0.19 + voice * 0.023) + voice) * 0.08;
    sample += (Math.sin(phase) * 0.82 + Math.sin(phase * 0.5) * 0.18) * motion;
  }
  return sample / chord.intervals.length;
}

const bellEvents = [
  { at: 2.3, note: 61 },
  { at: 8.7, note: 59 },
  { at: 15.0, note: 66 },
  { at: 21.3, note: 64 },
  { at: 27.5, note: 61 },
];

for (let i = 0; i < frames; i += 1) {
  const time = i / sampleRate;
  const chordPosition = time / chordSeconds;
  const chordIndex = Math.min(progression.length - 1, Math.floor(chordPosition));
  const nextChordIndex = Math.min(progression.length - 1, chordIndex + 1);
  const localChordTime = chordPosition - chordIndex;
  const crossfade = smoothStep(0.72, 1, localChordTime);
  const current = progression[chordIndex];
  const next = progression[nextChordIndex];

  const padLeft = chordPad(current, time, -1.4) * (1 - crossfade)
    + chordPad(next, time, -1.4) * crossfade;
  const padRight = chordPad(current, time, 1.4) * (1 - crossfade)
    + chordPad(next, time, 1.4) * crossfade;

  const rootFreq = frequency(current.root - 12);
  const bassMotion = 0.72 + Math.sin(time * Math.PI * 0.22) * 0.12;
  const bass = Math.sin(2 * Math.PI * rootFreq * time) * bassMotion;

  let bellLeft = 0;
  let bellRight = 0;
  for (let eventIndex = 0; eventIndex < bellEvents.length; eventIndex += 1) {
    const event = bellEvents[eventIndex];
    const age = time - event.at;
    if (age < 0 || age > 5.2) continue;
    const attack = smoothStep(0, 0.42, age);
    const release = Math.exp(-age * 0.62);
    const freq = frequency(event.note);
    const tone = Math.sin(2 * Math.PI * freq * time) * 0.78
      + Math.sin(2 * Math.PI * freq * 2.01 * time) * 0.16;
    const pan = eventIndex % 2 === 0 ? 0.88 : 1.12;
    bellLeft += tone * attack * release * pan;
    bellRight += tone * attack * release * (2 - pan);
  }

  const rawNoiseLeft = noise();
  const rawNoiseRight = noise();
  filteredNoiseLeft += (rawNoiseLeft - filteredNoiseLeft) * 0.0022;
  filteredNoiseRight += (rawNoiseRight - filteredNoiseRight) * 0.0022;
  const airSwell = 0.45 + Math.sin(time * Math.PI * 0.13) * 0.2;

  const opening = smoothStep(0, 2.2, time);
  const closing = 1 - smoothStep(29.2, duration, time);
  const arc = 0.82 + smoothStep(8, 20, time) * 0.18;
  const fade = opening * closing;

  left[i] = (
    padLeft * 0.115
    + bass * 0.034
    + bellLeft * 0.028
    + filteredNoiseLeft * airSwell * 0.022
  ) * fade * arc;
  right[i] = (
    padRight * 0.115
    + bass * 0.032
    + bellRight * 0.028
    + filteredNoiseRight * airSwell * 0.022
  ) * fade * arc;
}

const reverbTaps = [
  [0.17, 0.19],
  [0.29, 0.14],
  [0.43, 0.11],
  [0.61, 0.085],
  [0.83, 0.06],
];

for (const [delaySeconds, gain] of reverbTaps) {
  const delay = Math.round(delaySeconds * sampleRate);
  for (let i = delay; i < frames; i += 1) {
    left[i] += right[i - delay] * gain;
    right[i] += left[i - delay] * gain;
  }
}

let peak = 0;
for (let i = 0; i < frames; i += 1) {
  peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
}
const gain = peak > 0 ? 0.72 / peak : 1;
const pcm = Buffer.alloc(frames * channels * 2);
for (let i = 0; i < frames; i += 1) {
  const leftSample = Math.tanh(left[i] * gain * 1.1) / Math.tanh(1.1);
  const rightSample = Math.tanh(right[i] * gain * 1.1) / Math.tanh(1.1);
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
