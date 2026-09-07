import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sampleRate = 48_000;
const duration = 58;
const channels = 2;
const frames = sampleRate * duration;
const tempo = 104;
const beatSeconds = 60 / tempo;
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../public/audio/field-payroll/music-alt.wav');

const roots = [43, 39, 46, 41]; // G2, Eb2, Bb2, F2
const chords = [[0, 3, 7, 10], [0, 4, 7, 12], [0, 4, 7, 10], [0, 4, 7, 12]];
const motif = [12, 19, 15, 19, 22, 19, 15, 19];
let noiseState = 0x6d2b79f5;
let previousNoise = 0;

function noise() {
  noiseState ^= noiseState << 13;
  noiseState ^= noiseState >>> 17;
  noiseState ^= noiseState << 5;
  return ((noiseState >>> 0) / 0xffffffff) * 2 - 1;
}

function frequency(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

function triangle(freq, time) {
  const phase = time * freq;
  return 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1;
}

function softClip(value) {
  return Math.tanh(value * 1.2) / Math.tanh(1.2);
}

function smoothStep(from, to, value) {
  const position = Math.max(0, Math.min(1, (value - from) / (to - from)));
  return position * position * (3 - 2 * position);
}

const pcm = Buffer.alloc(frames * channels * 2);
for (let i = 0; i < frames; i += 1) {
  const time = i / sampleRate;
  const beat = time / beatSeconds;
  const beatIndex = Math.floor(beat);
  const beatPhase = beat - beatIndex;
  const eighth = Math.floor(beat * 2);
  const eighthPhase = beat * 2 - eighth;
  const sixteenth = Math.floor(beat * 4);
  const sixteenthPhase = beat * 4 - sixteenth;
  const bar = Math.floor(beat / 4);
  const progressionIndex = time > 51.5 ? 0 : bar % roots.length;
  const root = roots[progressionIndex];
  const chord = chords[progressionIndex];

  const intro = smoothStep(0, 2.8, time);
  const drumsIn = smoothStep(2.8, 5.5, time);
  const lift = 0.78 + smoothStep(17, 25, time) * 0.22;
  const breakdown = time > 36 && time < 41 ? 0.58 : 1;
  const resolve = 1 - smoothStep(52, 58, time) * 0.34;
  const ending = 1 - smoothStep(56, 58, time);
  const sidechain = 0.76 + 0.24 * smoothStep(0.08, 0.42, beatPhase);

  let padLeft = 0;
  let padRight = 0;
  for (let voice = 0; voice < chord.length; voice += 1) {
    const freq = frequency(root + 12 + chord[voice]);
    const movement = Math.sin(time * (0.11 + voice * 0.017) * Math.PI * 2) * 0.5 + 0.5;
    padLeft += Math.sin(2 * Math.PI * freq * time + voice * 0.37) * (0.72 + movement * 0.28);
    padRight += Math.sin(2 * Math.PI * freq * time + voice * 0.37 + 0.045) * (1 - movement * 0.2);
  }
  padLeft *= 0.015 * sidechain;
  padRight *= 0.015 * sidechain;

  const pluckNote = root + motif[eighth % motif.length];
  const pluckEnvelope = Math.exp(-eighthPhase * 7.5);
  const pluckTone = Math.sin(2 * Math.PI * frequency(pluckNote) * time) * 0.72
    + triangle(frequency(pluckNote) * 2, time) * 0.16;
  const pluck = pluckTone * pluckEnvelope * 0.038 * (eighth % 4 === 2 ? 0.55 : 1);

  const bassHit = beatIndex % 4 === 0 || beatIndex % 4 === 2;
  const bassEnvelope = bassHit ? Math.exp(-beatPhase * 4.6) : 0;
  const bass = Math.sin(2 * Math.PI * frequency(root) * time) * bassEnvelope * 0.09;

  const kickEnvelope = Math.exp(-beatPhase * 20);
  const kickPitch = 46 + 48 * Math.exp(-beatPhase * 25);
  const kickWeight = beatIndex % 4 === 0 ? 1 : beatIndex % 2 === 0 ? 0.72 : 0.38;
  const kick = Math.sin(2 * Math.PI * kickPitch * time) * kickEnvelope * 0.145 * kickWeight;

  const rawNoise = noise();
  const highNoise = rawNoise - previousNoise * 0.92;
  previousNoise = rawNoise;
  const rimBeat = beatIndex % 4 === 1 || beatIndex % 4 === 3;
  const rim = rimBeat && beatPhase < 0.12
    ? highNoise * Math.exp(-beatPhase * 40) * 0.025
    : 0;
  const shakerAccent = sixteenth % 4 === 2 || sixteenth % 8 === 7;
  const shaker = shakerAccent && sixteenthPhase < 0.16
    ? highNoise * Math.exp(-sixteenthPhase * 36) * 0.009
    : 0;

  const accentStep = sixteenth % 16 === 10 || sixteenth % 16 === 15;
  const accent = accentStep
    ? Math.sin(2 * Math.PI * frequency(root + 24) * time) * Math.exp(-sixteenthPhase * 10) * 0.014
    : 0;

  const rhythm = (bass + kick + rim + shaker + accent) * drumsIn * breakdown;
  const musical = (pluck * (0.74 + drumsIn * 0.26) + rhythm) * lift * resolve;
  const fade = intro * ending;
  const left = softClip((padLeft + musical * 0.98) * fade);
  const right = softClip((padRight + musical * 0.94 + pluck * 0.035) * fade);

  pcm.writeInt16LE(Math.round(left * 32767), i * 4);
  pcm.writeInt16LE(Math.round(right * 32767), i * 4 + 2);
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
